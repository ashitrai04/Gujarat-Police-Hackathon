import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { loadEnv } from 'vite'

const dirname = path.dirname(fileURLToPath(import.meta.url))

const SENTINEL_ORIGIN = 'https://cctv.corp8.cloud'

/**
 * Dev-only sign-in against the camera grid.
 *
 * The key comes from .env (SENTINEL_ACCESS_KEY) and never reaches the browser:
 * the proxy attaches the resulting session cookie on the way out. Production
 * does the same thing in api/sentinel.js.
 */
async function signIn(): Promise<string> {
  const key =
    process.env.SENTINEL_ACCESS_KEY ||
    loadEnv('development', dirname, '').SENTINEL_ACCESS_KEY ||
    ''
  if (!key) throw new Error('SENTINEL_ACCESS_KEY missing from .env')
  // The grid now requires email as well as the access key; a password-only
  // POST is answered 200 with the form re-rendered, which reads as a broken
  // feed rather than a rejected login.
  const email =
    process.env.SENTINEL_ACCESS_EMAIL ||
    loadEnv('development', dirname, '').SENTINEL_ACCESS_EMAIL ||
    ''
  const res = await fetch(`${SENTINEL_ORIGIN}/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      // Cloudflare serves a different response to a default Node user-agent.
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    body: new URLSearchParams(
      email ? { email, password: key } : { password: key },
    ).toString(),
    redirect: 'manual',
  })
  const lines =
    typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  for (const line of lines) {
    const m = /(?:^|;\s*)sentinel=([^;]+)/.exec(line)
    if (m) return `sentinel=${m[1]}`
  }
  throw new Error(`grid sign-in failed (${res.status}) — check SENTINEL_ACCESS_KEY`)
}

/**
 * Sign in before the server starts.
 *
 * NOTE: the grid allows one session per IP and evicts the previous one on every
 * login. Running two dev servers, or leaving a browser tab signed in to
 * cctv.corp8.cloud, means they take turns 403ing each other. Run one.
 *
 * http-proxy's `proxyReq` handler is synchronous — awaiting inside it sets the
 * header after the request has already gone out, which showed up as the grid
 * 302ing every call to /auth/login. Resolving the session here means the
 * cookie is always ready by the time a request needs it.
 */
const session = await signIn().catch((err: Error) => {
  console.error(`[sentinel] ${err.message} — camera feeds will not load`)
  return ''
})

/**
 * Serve api/demo-session.js during development with the very handler Vercel
 * runs, so shared-account sign-in behaves the same locally as in production.
 * It reads SENTINEL_DEMO_EMAIL / SENTINEL_DEMO_PASSWORD from the dev server's
 * environment or a local .env file (never committed); without them it answers
 * 501 and the normal sign-in form is used, exactly as a deployment would.
 */
function demoSession(): Plugin {
  return {
    name: 'sentinel-demo-session',
    configureServer(server) {
      const env = loadEnv('development', dirname, '')
      for (const k of ['SENTINEL_DEMO_EMAIL', 'SENTINEL_DEMO_PASSWORD', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']) {
        if (!process.env[k] && env[k]) process.env[k] = env[k]
      }
      server.middlewares.use('/api/demo-session', async (req, res) => {
        const mod = await import(pathToFileURL(path.join(dirname, 'api/demo-session.js')).href)
        const out: Response = await mod.default(new Request('http://localhost/api/demo-session', { method: req.method }))
        res.statusCode = out.status
        res.setHeader('content-type', out.headers.get('content-type') ?? 'application/json')
        res.setHeader('cache-control', 'no-store')
        res.end(await out.text())
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), demoSession()],
  resolve: {
    alias: { '@': path.resolve(dirname, './src') },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      /**
       * The grid is behind an access key and serves HLS only. The proxy signs
       * in once, injects the session cookie, and rewrites the playlist's
       * absolute key URI (`URI="/enc.key"`) so hls.js fetches it back through
       * here instead of against the dev server's own root, where it would get
       * index.html and fail to decrypt.
       */
      '/sentinel': {
        target: SENTINEL_ORIGIN,
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/sentinel/, ''),
        selfHandleResponse: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            try {
              for (const h of [
                'origin', 'referer', 'sec-fetch-site', 'sec-fetch-mode',
                'sec-fetch-dest', 'sec-fetch-user', 'cookie',
              ]) proxyReq.removeHeader(h)
              if (session) proxyReq.setHeader('cookie', session)
            } catch {
              /* headers already flushed — nothing to scrub */
            }
          })

          proxy.on('proxyRes', (proxyRes, req, res) => {
            const chunks: Buffer[] = []
            proxyRes.on('data', (c) => chunks.push(c))
            proxyRes.on('end', () => {
              const body = Buffer.concat(chunks)
              const headers = { ...proxyRes.headers }
              delete headers['set-cookie']
              delete headers['content-encoding']
              delete headers['content-length']
              headers['access-control-allow-origin'] = '*'

              if (req.url?.includes('.m3u8')) {
                const text = body
                  .toString('utf8')
                  .replace(/URI="\/(?!\/)/g, 'URI="/sentinel/')
                  .replace(/^\/(?!\/)/gm, '/sentinel/')
                headers['content-type'] = 'application/vnd.apple.mpegurl'
                res.writeHead(proxyRes.statusCode ?? 200, headers)
                res.end(text)
                return
              }

              res.writeHead(proxyRes.statusCode ?? 200, headers)
              res.end(body)
            })
          })
        },
      },
    },
  },
})
