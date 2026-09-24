import { parseOverlay, parseEvidenceCsv, IMPORT_MAX_BYTES } from './imports.js';
import { safeSourceUrl, downloadText } from './workspace.js';

export function mountWorkspaceTools({
  container,
  documentRef: doc,
  onImport,
  onBackup,
  onRefresh,
  onNotice,
}) {
  const make = (tag, text) => {
    const e = doc.createElement(tag);
    if (text) e.textContent = text;
    return e;
  };
  const root = make('details'),
    summary = make('summary', 'Notes, diligence & local imports');
  root.append(summary);
  container.append(root);
  const intro = make(
    'p',
    'Analyst inputs stay on this browser. Save the site to retain them. They are separate from public-source facts.',
  );
  root.append(intro);
  const fields = {};
  for (const [name, label, placeholder] of [
    ['strategy', 'Strategy', 'Acquire, develop, reposition...'],
    ['units', 'Subject units', 'User estimate, if known'],
    ['vintage', 'Building vintage', 'Year built, if known'],
    [
      'disposition',
      'Screening disposition',
      'Proceed, hold, decline, or not assessed',
    ],
    ['nextStep', 'Next diligence action', 'Who will verify what?'],
    [
      'notes',
      'Analyst notes',
      'Rents, taxes, insurance, utilities, access, entitlement...',
    ],
  ]) {
    const wrapper = make('label', label),
      input = make(name === 'notes' ? 'textarea' : 'input');
    input.name = name;
    input.maxLength = name === 'notes' ? 3000 : 300;
    input.placeholder = placeholder;
    wrapper.append(input);
    root.append(wrapper);
    fields[name] = input;
  }
  const refresh = make('button', 'Refresh current site');
  refresh.type = 'button';
  refresh.addEventListener('click', () => onRefresh());
  root.append(refresh);
  const imports = make('details'),
    importTitle = make('summary', 'Import your own evidence');
  imports.append(importTitle);
  root.append(imports);
  imports.append(
    make(
      'p',
      'Import a dated official GeoJSON layer for local crime, parcel/area boundaries or other context. Polygon acreage is geometry-derived, not surveyed; imported shapes do not redefine Census or county statistics. CSV evidence is previewed before adding.',
    ),
  );
  const type = make('select');
  type.setAttribute('aria-label', 'Import type');
  for (const [value, label] of [
    ['geojson', 'Map overlay / custom area (GeoJSON)'],
    ['comps', 'Rent comps (CSV)'],
    ['pipeline', 'Development pipeline (CSV)'],
    ['backup', 'Saved-site backup (JSON)'],
  ]) {
    const option = make('option', label);
    option.value = value;
    type.append(option);
  }
  imports.append(type);
  const source = make('input');
  source.placeholder = 'Source URL (required for map overlays)';
  source.setAttribute('aria-label', 'Imported evidence source URL');
  imports.append(source);
  const asof = make('input');
  asof.type = 'date';
  asof.setAttribute('aria-label', 'Evidence as-of date');
  imports.append(asof);
  const file = make('input');
  file.type = 'file';
  file.accept = '.json,.geojson,.csv';
  file.setAttribute('aria-label', 'Choose evidence file');
  imports.append(file);
  const preview = make('p'),
    apply = make('button', 'Add reviewed import');
  apply.type = 'button';
  apply.disabled = true;
  imports.append(preview, apply);
  let pending = null;
  let readGeneration = 0;
  const clear = () => {
    readGeneration++;
    pending = null;
    apply.disabled = true;
    preview.textContent = '';
  };
  type.addEventListener('change', clear);
  source.addEventListener('input', clear);
  asof.addEventListener('input', clear);
  file.addEventListener('change', async () => {
    clear();
    const run = readGeneration,
      kind = type.value,
      sourceValue = source.value,
      dateValue = asof.value;
    const selected = file.files?.[0];
    if (!selected) return;
    try {
      if (
        selected.size > (type.value === 'backup' ? 3_500_000 : IMPORT_MAX_BYTES)
      )
        throw new Error('File exceeds the import size limit.');
      const text = await selected.text();
      if (run !== readGeneration) return;
      if (kind === 'backup') {
        pending = { type: 'backup', text };
        preview.textContent =
          'Merge saved sites from this backup. Existing IDs will be preserved.';
      } else if (kind === 'geojson') {
        const url = safeSourceUrl(sourceValue);
        if (!url || !dateValue)
          throw new Error(
            'Add the source URL and as-of date before choosing the overlay.',
          );
        const data = parseOverlay(text);
        pending = {
          type: 'geojson',
          data,
          source: url,
          asOf: dateValue,
          name: selected.name.slice(0, 120),
        };
        preview.textContent = `${data.count} features; ${data.acres} geometry-derived acres. Check the source and date before adding.`;
      } else {
        const rows = parseEvidenceCsv(text, kind);
        pending = { type: kind, rows, name: selected.name.slice(0, 120) };
        preview.textContent = `${rows.length} ${type.value === 'comps' ? 'rent comp' : 'pipeline'} records parsed. First: ${rows[0].name}. These are user-supplied, not independently verified.`;
      }
      apply.disabled = false;
    } catch (e) {
      onNotice(e.message);
      preview.textContent = e.message;
    }
  });
  apply.addEventListener('click', () => {
    try {
      if (pending?.type === 'backup') onBackup(pending.text);
      else if (pending) onImport(pending);
      clear();
    } catch (e) {
      onNotice(e.message);
    }
  });
  const template = make('button', 'Download CSV template');
  template.type = 'button';
  template.addEventListener('click', () => {
    const comps = type.value !== 'pipeline';
    downloadText(
      comps
        ? 'name,unit_type,asking_rent,lease_months,concession_total,as_of,source_url\n'
        : 'name,units,stage,as_of,source_url,expected_date\n',
      comps ? 'rent-comps-template.csv' : 'pipeline-template.csv',
      'text/csv',
      doc,
    );
  });
  imports.append(template);
  return {
    resetPendingImport: clear,
    getAnalyst: () =>
      Object.fromEntries(
        Object.entries(fields).map(([key, input]) => [key, input.value.trim()]),
      ),
    setAnalyst(values = {}) {
      for (const [key, input] of Object.entries(fields))
        input.value = String(values[key] || '');
    },
    destroy() {
      clear();
      root.remove();
    },
  };
}
