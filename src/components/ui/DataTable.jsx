import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { ui } from '../../styles/ui';
import Button from './Button';

/**
 * Ticked rows for a DataTable's `selection`. Only rows still in `rows` count as selected,
 * so filtering or searching never acts on rows the user can't see.
 */
export function useSelection(rows) {
  const [ids, setIds] = useState(() => new Set());
  const selected = rows.filter((r) => ids.has(r.id));
  const toggle = useCallback(
    (id) =>
      setIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  const setMany = useCallback(
    (list, on) =>
      setIds((prev) => {
        const next = new Set(prev);
        list.forEach((id) => (on ? next.add(id) : next.delete(id)));
        return next;
      }),
    [],
  );
  const clear = useCallback(() => setIds(new Set()), []);
  return { selected, isSelected: (id) => ids.has(id), toggle, setMany, clear };
}

function Checkbox({ checked, indeterminate = false, onChange, label }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={checked}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
      className="h-4 w-4 cursor-pointer rounded border-gray-300 text-teal-600 focus:ring-teal-500 dark:border-gray-600 dark:bg-gray-800"
    />
  );
}

/** "3 selected · [actions] · ×" above a table with ticked rows. Renders nothing when none are. */
export function BulkBar({ selection, children }) {
  const count = selection.selected.length;
  if (!count) return null;
  return (
    <div className={`flex flex-wrap items-center gap-2 border-b bg-teal-50/70 px-4 py-2.5 text-sm dark:bg-teal-500/10 sm:px-5 ${ui.line}`}>
      <span className={`mr-1 font-medium ${ui.h}`}>{count} selected</span>
      {children}
      <button type="button" onClick={selection.clear} className={`ml-auto ${ui.icon}`} aria-label="Clear selection" title="Clear selection">
        <X size={15} />
      </button>
    </div>
  );
}

/**
 * Table on md+, stacked cards on phones.
 * Column flags: `primary` (card title), `aside` (card top-right), `actions` (card footer),
 * `mobileHidden`, `align: 'right'`. `render(row)` overrides `row[key]`.
 * `selection` (from useSelection) adds a checkbox to each row and a select-all box.
 */
export default function DataTable({ columns, rows, empty = 'Nothing to show.', onRowClick, pageSize = 0, selection }) {
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [rows.length]);

  const pageCount = pageSize ? Math.max(1, Math.ceil(rows.length / pageSize)) : 1;
  const visible = pageSize ? rows.slice(page * pageSize, page * pageSize + pageSize) : rows;

  const primary = columns.find((c) => c.primary) || columns[0];
  const aside = columns.find((c) => c.aside);
  const actions = columns.find((c) => c.actions);
  const details = columns.filter((c) => c !== primary && c !== aside && c !== actions && !c.mobileHidden);
  const cell = (column, row) => (column.render ? column.render(row) : row[column.key]);
  const allChecked = !!selection && rows.length > 0 && selection.selected.length === rows.length;
  const someChecked = !!selection && selection.selected.length > 0 && !allChecked;
  const rowBox = (row) =>
    selection && <Checkbox label="Select row" checked={selection.isSelected(row.id)} onChange={() => selection.toggle(row.id)} />;

  return (
    <div>
      <div className="hidden overflow-x-auto md:block">
        <table className="min-w-full text-sm">
          <thead>
            <tr className={`border-b bg-gray-50/70 text-left text-xs font-medium uppercase tracking-wide dark:bg-gray-800/40 ${ui.line} ${ui.muted}`}>
              {selection && (
                <th className="w-10 py-2.5 pl-5 pr-0">
                  <Checkbox
                    label="Select all"
                    checked={allChecked}
                    indeterminate={someChecked}
                    onChange={() => selection.setMany(rows.map((r) => r.id), !allChecked)}
                  />
                </th>
              )}
              {columns.map((c) => (
                <th key={c.key} className={`whitespace-nowrap px-5 py-2.5 ${c.align === 'right' ? 'text-right' : ''}`}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className={ui.divide}>
            {visible.map((row) => (
              <tr
                key={row.id}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={`${ui.hover} ${onRowClick ? 'cursor-pointer' : ''} ${selection?.isSelected(row.id) ? 'bg-teal-50/50 dark:bg-teal-500/5' : ''}`}
              >
                {selection && <td className="w-10 py-3 pl-5 pr-0">{rowBox(row)}</td>}
                {columns.map((c) => (
                  <td key={c.key} className={`px-5 py-3 ${ui.body} ${c.align === 'right' ? 'whitespace-nowrap text-right tabular-nums' : ''}`}>
                    {cell(c, row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selection && rows.length > 0 && (
        <label className={`flex items-center gap-2 border-b px-4 py-2 text-xs md:hidden ${ui.line} ${ui.muted}`}>
          <Checkbox label="Select all" checked={allChecked} indeterminate={someChecked} onChange={() => selection.setMany(rows.map((r) => r.id), !allChecked)} />
          Select all {rows.length}
        </label>
      )}
      <ul className={`md:hidden ${ui.divide}`}>
        {visible.map((row) => (
          <li key={row.id} onClick={onRowClick ? () => onRowClick(row) : undefined} className={`px-4 py-3.5 ${onRowClick ? `cursor-pointer ${ui.hover}` : ''}`}>
            <div className="flex items-start justify-between gap-3">
              {selection && <div className="pt-0.5">{rowBox(row)}</div>}
              <div className={`min-w-0 flex-1 text-sm font-medium ${ui.h}`}>{cell(primary, row)}</div>
              {aside && <div className="shrink-0 text-sm tabular-nums">{cell(aside, row)}</div>}
            </div>
            {details.length > 0 && (
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                {details.map((c) => (
                  <div key={c.key} className="min-w-0">
                    <dt className={ui.muted}>{c.label}</dt>
                    <dd className={`mt-0.5 truncate ${ui.body}`}>{cell(c, row)}</dd>
                  </div>
                ))}
              </dl>
            )}
            {actions && <div className="mt-2.5 flex justify-end">{cell(actions, row)}</div>}
          </li>
        ))}
      </ul>

      {rows.length === 0 && <p className={`px-5 py-10 text-center text-sm ${ui.muted}`}>{empty}</p>}

      {pageSize > 0 && rows.length > pageSize && (
        <div className={`flex items-center justify-between gap-2 border-t px-4 py-3 text-sm sm:px-5 ${ui.line} ${ui.muted}`}>
          <span>
            {page * pageSize + 1}–{Math.min(rows.length, (page + 1) * pageSize)} of {rows.length}
          </span>
          <div className="flex gap-2">
            <Button size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <Button size="sm" disabled={page >= pageCount - 1} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
