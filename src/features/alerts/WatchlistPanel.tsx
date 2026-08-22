import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '@/api/client';
import { Button, Card, Empty, Pill, SectionHeader, Spinner } from '@/components/ui';
import { CATEGORY_COLOR, type WatchlistCategory } from '@/api/types';

const CATEGORIES: WatchlistCategory[] = ['stolen', 'wanted', 'missing', 'suspect'];

export function WatchlistPanel() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['watchlist'], queryFn: api.watchlist });
  const [plate, setPlate] = useState('');
  const [category, setCategory] = useState<WatchlistCategory>('stolen');
  const [notes, setNotes] = useState('');

  const invalidate = () => qc.invalidateQueries({ queryKey: ['watchlist'] });

  const add = useMutation({
    mutationFn: () =>
      api.addWatchlist({ plate, category, personName: null, active: true, notes }),
    onSuccess: () => {
      setPlate('');
      setNotes('');
      invalidate();
    },
  });
  const toggle = useMutation({
    mutationFn: (v: { id: string; active: boolean }) => api.toggleWatchlist(v.id, v.active),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.removeWatchlist(id),
    onSuccess: invalidate,
  });

  return (
    <div className="flex flex-col gap-3 p-3">
      <Card>
        <SectionHeader>Add to watchlist</SectionHeader>
        <div className="flex flex-col gap-2 px-3 pb-3">
          <input
            value={plate}
            onChange={(e) => setPlate(e.target.value.toUpperCase())}
            placeholder="GJ01AB1234"
            className="mono rounded-[6px] px-2.5 py-[7px] text-[13px] outline-none"
            style={{
              background: 'var(--surface-2)',
              border: '1px solid var(--line)',
              color: 'var(--text)',
            }}
          />
          <div className="flex gap-1">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className="flex-1 rounded-[5px] py-[5px] text-[11px] capitalize transition-colors"
                style={{
                  background: category === c ? `${CATEGORY_COLOR[c]}22` : 'var(--surface-2)',
                  border: `1px solid ${category === c ? CATEGORY_COLOR[c] : 'var(--line)'}`,
                  color: category === c ? CATEGORY_COLOR[c] : 'var(--text-dim)',
                }}
              >
                {c}
              </button>
            ))}
          </div>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Reason / FIR reference (optional)"
            className="rounded-[6px] px-2.5 py-[7px] text-[12px] outline-none"
            style={{
              background: 'var(--surface-2)',
              border: '1px solid var(--line)',
              color: 'var(--text)',
            }}
          />
          <Button
            variant="primary"
            disabled={!plate.trim() || add.isPending}
            onClick={() => add.mutate()}
          >
            {add.isPending ? <Spinner /> : <Plus size={13} />} Add entry
          </Button>
        </div>
      </Card>

      <Card>
        <SectionHeader
          right={
            <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
              {data?.filter((w) => w.active).length ?? 0} active
            </span>
          }
        >
          Entries
        </SectionHeader>
        {isLoading ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : !data?.length ? (
          <Empty>The watchlist is empty. Add a registration number above to start matching.</Empty>
        ) : (
          <ul className="px-3 pb-3">
            {data.map((w) => (
              <li
                key={w.id}
                className="flex items-start gap-2 border-b py-2 last:border-0"
                style={{ borderColor: 'var(--line-soft)' }}
              >
                <button
                  onClick={() => toggle.mutate({ id: w.id, active: !w.active })}
                  className="mt-[3px] h-[22px] w-[34px] shrink-0 rounded-full p-[3px] transition-colors"
                  style={{ background: w.active ? 'var(--signal)' : 'var(--line)' }}
                  aria-label={w.active ? 'Deactivate' : 'Activate'}
                >
                  <span
                    className="block h-4 w-4 rounded-full bg-white transition-transform"
                    style={{ transform: w.active ? 'translateX(12px)' : 'none' }}
                  />
                </button>

                <div className="min-w-0 flex-1" style={{ opacity: w.active ? 1 : 0.45 }}>
                  <div className="flex items-center gap-1.5">
                    <span className="mono text-[13px] font-medium" style={{ color: 'var(--text)' }}>
                      {w.plate}
                    </span>
                    <Pill colour={CATEGORY_COLOR[w.category]}>{w.category}</Pill>
                  </div>
                  {w.notes && (
                    <p className="mt-0.5 text-[10.5px] leading-snug" style={{ color: 'var(--text-mute)' }}>
                      {w.notes}
                    </p>
                  )}
                </div>

                <button
                  onClick={() => remove.mutate(w.id)}
                  className="mt-[3px] rounded-[4px] p-1 hover:bg-[var(--surface-2)]"
                  style={{ color: 'var(--text-mute)' }}
                  aria-label={`Remove ${w.plate}`}
                >
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
