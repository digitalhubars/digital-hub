// PDF reports for the list pages and the dashboard. jsPDF is loaded only when someone
// downloads a report, so it doesn't slow down the first page load.

/**
 * title:    big heading, e.g. "Orders"
 * subtitle: one line under it, e.g. "This month · All stores"
 * stats:    [[label, value], …] shown as a summary row (optional)
 * sections: [{ heading?, columns: [header…], rows: [[cell…]…] }]
 * filename: without extension
 * workspace: name shown in the header
 */
export async function downloadPdf({ title, subtitle, stats = [], sections = [], filename, workspace = 'Digital Hub' }) {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const width = doc.internal.pageSize.getWidth();
  const margin = 40;
  const teal = [15, 118, 110];
  const muted = [107, 114, 128];

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...teal);
  doc.text(workspace.toUpperCase(), margin, 40);
  doc.setFontSize(20);
  doc.setTextColor(17, 24, 39);
  doc.text(title, margin, 64);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(...muted);
  const generated = `Generated ${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}`;
  doc.text([subtitle, generated].filter(Boolean).join('  ·  '), margin, 82);

  let y = 104;
  if (stats.length) {
    const gap = 10;
    const boxW = (width - margin * 2 - gap * (stats.length - 1)) / stats.length;
    stats.forEach(([label, value], i) => {
      const x = margin + i * (boxW + gap);
      doc.setDrawColor(229, 231, 235);
      doc.setFillColor(249, 250, 251);
      doc.roundedRect(x, y, boxW, 52, 6, 6, 'FD');
      doc.setFontSize(9);
      doc.setTextColor(...muted);
      doc.text(String(label), x + 12, y + 18);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(15);
      doc.setTextColor(17, 24, 39);
      doc.text(String(value), x + 12, y + 40);
      doc.setFont('helvetica', 'normal');
    });
    y += 72;
  }

  sections.forEach((section) => {
    if (section.heading) {
      if (y > doc.internal.pageSize.getHeight() - 80) {
        doc.addPage();
        y = 40;
      }
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12);
      doc.setTextColor(17, 24, 39);
      doc.text(section.heading, margin, y);
      doc.setFont('helvetica', 'normal');
      y += 8;
    }
    autoTable(doc, {
      startY: y,
      head: [section.columns],
      body: section.rows.length ? section.rows : [[{ content: 'Nothing to show.', colSpan: section.columns.length }]],
      margin: { left: margin, right: margin },
      styles: { font: 'helvetica', fontSize: 9, cellPadding: 5, textColor: [55, 65, 81] },
      headStyles: { fillColor: teal, textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [249, 250, 251] },
    });
    y = doc.lastAutoTable.finalY + 28;
  });

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(...muted);
    doc.text(`Page ${i} of ${pages}`, width - margin, doc.internal.pageSize.getHeight() - 20, { align: 'right' });
  }

  doc.save(`${filename}-${new Date().toISOString().slice(0, 10)}.pdf`);
}
