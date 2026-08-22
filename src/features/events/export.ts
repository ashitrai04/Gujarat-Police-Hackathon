import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

export interface ReportRow {
  plate: string;
  camera: string;
  cameraId: string;
  vehicle: string;
  colour: string;
  confidence: string;
  timestamp: string;
}

const COLUMNS: Array<{ key: keyof ReportRow; header: string }> = [
  { key: 'plate', header: 'Plate' },
  { key: 'cameraId', header: 'Camera ID' },
  { key: 'camera', header: 'Camera' },
  { key: 'vehicle', header: 'Vehicle' },
  { key: 'colour', header: 'Colour' },
  { key: 'confidence', header: 'Confidence' },
  { key: 'timestamp', header: 'Timestamp' },
];

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

export function exportCsv(rows: ReportRow[]) {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const body = [
    COLUMNS.map((c) => c.header).join(','),
    ...rows.map((r) => COLUMNS.map((c) => esc(String(r[c.key] ?? ''))).join(',')),
  ].join('\n');

  const blob = new Blob([`﻿${body}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sentinel-detections-${stamp()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportPdf(rows: ReportRow[], meta: { plate?: string; hours: number }) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });

  doc.setFontSize(15);
  doc.setTextColor(20, 28, 43);
  doc.text('Sentinel — detected vehicles report', 40, 40);

  doc.setFontSize(9);
  doc.setTextColor(110, 120, 138);
  const filters = [
    `Generated ${new Date().toLocaleString('en-GB')}`,
    `Window: last ${meta.hours}h`,
    meta.plate ? `Plate filter: ${meta.plate}` : 'Plate filter: none',
    `${rows.length} detections`,
  ].join('   ·   ');
  doc.text(filters, 40, 57);

  autoTable(doc, {
    startY: 72,
    head: [COLUMNS.map((c) => c.header)],
    body: rows.map((r) => COLUMNS.map((c) => String(r[c.key] ?? ''))),
    styles: { fontSize: 8, cellPadding: 4, textColor: [30, 38, 55] },
    headStyles: { fillColor: [19, 28, 43], textColor: [231, 236, 243], fontSize: 8 },
    alternateRowStyles: { fillColor: [244, 247, 251] },
    columnStyles: { 0: { font: 'courier', fontStyle: 'bold' } },
  });

  doc.save(`sentinel-detections-${stamp()}.pdf`);
}
