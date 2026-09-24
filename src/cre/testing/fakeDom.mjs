// A tiny DOM stand-in for the CRE panel and mode tests (no jsdom): elements, attributes, classList, events and simple attribute/id/tag selectors.

class FakeClassList {
  constructor(el) {
    this.el = el;
  }
  get set() {
    return new Set(this.el.className.split(/\s+/).filter(Boolean));
  }
  write(set) {
    this.el.className = [...set].join(' ');
  }
  add(...names) {
    const set = this.set;
    names.forEach((n) => set.add(n));
    this.write(set);
  }
  remove(...names) {
    const set = this.set;
    names.forEach((n) => set.delete(n));
    this.write(set);
  }
  contains(name) {
    return this.set.has(name);
  }
  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : Boolean(force);
    if (on) this.add(name);
    else this.remove(name);
    return on;
  }
}

export class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.className = '';
    this.classList = new FakeClassList(this);
    this.listeners = new Map();
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this._text = '';
  }
  get id() {
    return this.attributes.get('id') || '';
  }
  set id(value) {
    this.attributes.set('id', String(value));
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(value) {
    this.children.forEach((c) => (c.parentNode = null));
    this.children = [];
    this._text = String(value ?? '');
  }
  get nextSibling() {
    const siblings = this.parentNode?.children || [];
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  _detach(node) {
    if (node.parentNode) {
      const list = node.parentNode.children;
      list.splice(list.indexOf(node), 1);
    }
    node.parentNode = this;
  }
  append(...nodes) {
    for (const node of nodes) {
      this._detach(node);
      this.children.push(node);
    }
  }
  appendChild(node) {
    this.append(node);
    return node;
  }
  prepend(...nodes) {
    for (const node of nodes.reverse()) {
      this._detach(node);
      this.children.unshift(node);
    }
  }
  insertBefore(node, ref) {
    if (!ref) return this.appendChild(node);
    this._detach(node);
    this.children.splice(this.children.indexOf(ref), 0, node);
    return node;
  }
  replaceChildren(...nodes) {
    this.children.forEach((c) => (c.parentNode = null));
    this.children = [];
    this._text = '';
    this.append(...nodes);
  }
  remove() {
    if (!this.parentNode) return;
    const list = this.parentNode.children;
    list.splice(list.indexOf(this), 1);
    this.parentNode = null;
  }
  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }
  dispatch(type) {
    for (const fn of this.listeners.get(type) || []) fn({ type, target: this });
  }
  click() {
    this.dispatch('click');
  }
  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }
  *descendants() {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }
  querySelectorAll(selector) {
    const match = matcher(selector);
    return [...this.descendants()].filter(match);
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

/** Supports `#id`, `tag`, `.class`, `[attr]` and `[attr="value"]`. */
function matcher(selector) {
  const attr = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
  if (attr) {
    const [, name, value] = attr;
    return (el) =>
      el.hasAttribute(name) &&
      (value === undefined || el.getAttribute(name) === value);
  }
  if (selector.startsWith('#')) return (el) => el.id === selector.slice(1);
  if (selector.startsWith('.'))
    return (el) => el.classList.contains(selector.slice(1));
  return (el) => el.tagName === selector.toUpperCase();
}

export function createFakeDocument() {
  const doc = {
    activeElement: null,
    createElement: (tag) => new FakeElement(tag, doc),
    createElementNS: (_ns, tag) => new FakeElement(tag, doc),
    getElementById: (id) =>
      doc.documentElement.id === id
        ? doc.documentElement
        : doc.documentElement.querySelector(`#${id}`),
    querySelector: (s) => doc.documentElement.querySelector(s),
    querySelectorAll: (s) => doc.documentElement.querySelectorAll(s),
  };
  doc.documentElement = new FakeElement('html', doc);
  doc.body = new FakeElement('body', doc);
  doc.documentElement.append(doc.body);
  return doc;
}
