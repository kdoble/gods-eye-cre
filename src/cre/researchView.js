import { RESEARCH_LAYER_DEFINITIONS } from './researchLayers.js';

const STATUS_LABEL = Object.freeze({
  queued: 'Queued',
  researching: 'Researching',
  ready: 'Ready',
  partial: 'Partial',
  failed: 'Failed',
  skipped: 'Skipped',
});

/** Mount the local Analysis workspace controls into the panel's Analysis slot. */
export function mountResearchTab({
  container,
  controller,
  documentRef = globalThis.document,
} = {}) {
  if (!container || !controller || !documentRef?.createElement) return () => {};
  const root = documentRef.createElement('section');
  root.className = 'cre-research-workspace';
  root.setAttribute('aria-label', 'Address research');
  container.append(root);

  const render = () => {
    const snapshot = controller.getSnapshot();
    const prefs = controller.getPreferences();
    const selected = new Set(controller.getSelected());
    const byId = new Map(
      (snapshot?.layers || []).map((layer) => [layer.id, layer]),
    );
    const hasProvider = controller.hasProvider?.() === true;
    const canRun = controller.canRun?.() === true;
    root.replaceChildren();

    const heading = documentRef.createElement('h3');
    heading.textContent = hasProvider
      ? 'Research layers'
      : 'Additional research setup';
    root.append(heading);
    const intro = documentRef.createElement('p');
    intro.textContent = !snapshot
      ? 'Confirm an address to choose optional research. Existing dossier data loads independently.'
      : !canRun
        ? 'Review selections for this address. Confirm the map point before running site-specific research.'
        : hasProvider
          ? 'Choose optional research for this confirmed address. Switching roles does not run searches.'
          : 'Choose the layers you want to research when the optional source-discovery service is connected.';
    root.append(intro);

    if (!hasProvider) {
      const unavailable = documentRef.createElement('p');
      unavailable.className = 'cre-research-unavailable';
      unavailable.setAttribute('role', 'status');
      unavailable.textContent =
        'The optional source-discovery service is not connected in this build. Run and automatic research are disabled; selecting layers saves your choices without sending site information. Existing dossier data remains available.';
      root.append(unavailable);
    }

    const options = documentRef.createElement('fieldset');
    const legend = documentRef.createElement('legend');
    legend.textContent = 'Research selections';
    options.append(legend);
    for (const layer of RESEARCH_LAYER_DEFINITIONS) {
      const row = documentRef.createElement('label');
      row.className = 'cre-research-option';
      const checkbox = documentRef.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = layer.id;
      checkbox.checked = selected.has(layer.id);
      checkbox.addEventListener('change', () => {
        const next = new Set(controller.getSelected());
        checkbox.checked ? next.add(layer.id) : next.delete(layer.id);
        controller.setSelected([...next]);
      });
      const title = documentRef.createElement('span');
      title.textContent = layer.label;
      row.append(checkbox, title);
      const result = byId.get(layer.id);
      if (result) {
        const status = documentRef.createElement('small');
        status.textContent = STATUS_LABEL[result.status] || 'Skipped';
        row.append(status);
      }
      options.append(row);
    }
    root.append(options);

    const autoRow = documentRef.createElement('label');
    autoRow.className = 'cre-research-auto';
    const auto = documentRef.createElement('input');
    auto.type = 'checkbox';
    auto.checked = prefs.autoRun;
    auto.disabled = !hasProvider;
    auto.addEventListener('change', () =>
      controller.setPreferences({ ...prefs, autoRun: auto.checked }),
    );
    const autoText = documentRef.createElement('span');
    autoText.textContent =
      'Run these selections automatically for new confirmed addresses';
    autoRow.append(auto, autoText);
    root.append(autoRow);

    const budget = documentRef.createElement('p');
    budget.textContent = `Up to ${prefs.budgetPerAddress} selected research layers run per address. Other checked layers stay selected.`;
    root.append(budget);

    const actions = documentRef.createElement('div');
    actions.className = 'cre-research-actions';
    const run = documentRef.createElement('button');
    run.type = 'button';
    run.textContent = 'Run selected';
    run.disabled = !hasProvider || !snapshot || !selected.size || !canRun;
    run.addEventListener('click', () => {
      void controller.runSelected().then(render);
    });
    actions.append(run);
    const cancel = documentRef.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel remaining';
    cancel.disabled = snapshot?.status !== 'researching';
    cancel.addEventListener('click', () => {
      controller.cancel();
      render();
    });
    actions.append(cancel);
    root.append(actions);

    const results = documentRef.createElement('div');
    results.className = 'cre-research-results';
    for (const layer of snapshot?.layers || []) {
      const card = documentRef.createElement('article');
      const title = documentRef.createElement('h4');
      title.textContent = `${layer.label}: ${STATUS_LABEL[layer.status] || 'Skipped'}`;
      card.append(title);
      if (layer.summary) {
        const summary = documentRef.createElement('p');
        summary.textContent = layer.summary;
        card.append(summary);
      }
      if (layer.message) {
        const note = documentRef.createElement('p');
        note.textContent = layer.message;
        card.append(note);
      }
      for (const evidence of layer.evidence || []) {
        const item = documentRef.createElement('p');
        item.textContent = evidence.claim;
        card.append(item);
      }
      for (const source of layer.sources || []) {
        const link = documentRef.createElement('a');
        link.href = source.url;
        link.rel = 'noopener noreferrer';
        link.target = '_blank';
        link.textContent = source.title || source.url;
        card.append(link);
      }
      if (
        selected.has(layer.id) &&
        ['failed', 'partial', 'skipped'].includes(layer.status)
      ) {
        const retry = documentRef.createElement('button');
        retry.type = 'button';
        retry.textContent = 'Retry this layer';
        retry.disabled = !hasProvider || !canRun;
        retry.addEventListener('click', () => {
          void controller.retryLayer(layer.id).then(render);
        });
        card.append(retry);
      }
      results.append(card);
    }
    root.append(results);
  };

  const unsubscribe =
    typeof controller.subscribe === 'function'
      ? controller.subscribe(render)
      : null;
  render();
  return () => {
    unsubscribe?.();
    root.remove();
  };
}
