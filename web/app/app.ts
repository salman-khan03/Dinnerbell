/**
 * Dinner Bell's first-party web app: sign up, plan a meal, watch it replan
 * live as you report progress, publish dishes to the public gallery, fork
 * other people's dishes into your own kitchen, and share a plan by link.
 *
 * No MCP client here — this is the plain product, talking to `/api/*` (see
 * src/server/webapp.ts) with a normal cookie session. The MCP/Alexa+ side of
 * Dinner Bell (`/mcp`, `/sim`) is the same server, same data, same engine —
 * just a different front door.
 */

const PALETTE = ['#fb923c', '#4ade80', '#60a5fa', '#facc15', '#f472b6', '#2dd4bf', '#a78bfa', '#fb7185', '#a3e635', '#22d3ee'];
const STATE_LABEL: Record<string, string> = { on_track: 'On track', tight: 'Tight but doable', late: 'Running late', impossible: 'Not enough time' };

const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document): T => root.querySelector(sel) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string | null)[]): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k === 'class' ? (n.className = v) : n.setAttribute(k, v);
  for (const k of kids) if (k !== null) n.append(k);
  return n;
};
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const oneOf = <T extends string>(v: string, allowed: readonly T[], fb: T): T => ((allowed as readonly string[]).includes(v) ? (v as T) : fb);
const root = $('#root');

interface Task {
  key: string; dish: string; dish_id: string; step: string; start: string; end: string;
  start_local: string; end_local: string; attention: string; appliance: string | null;
  status: string; before_cooking_window: boolean; notes: string[];
}
interface Plan {
  plan_id: string; state: string; headline: string; guests: number; cooks: number; ovens: number;
  timezone: string; now: string; serve_target_local: string; serve_target_day: string;
  achievable_local: string; slack_minutes: number;
  dishes: { id: string; name: string; course: string }[]; tasks: Task[];
  ahead_of_time: { text: string; when: string | null }[]; warnings: string[];
  suggestions: { kind: string; message: string; saves_minutes: number | null }[];
}
interface Outcome { text: string; view?: Plan; data?: Record<string, unknown>; needsInput?: string[]; isError?: boolean }
interface Me { signedIn: boolean; username?: string; household?: { name: string; kitchen: { cooks: number; ovens: number }; kitchenKnown: boolean } }
interface CatalogDish { id: string; name: string; course: string; cuisine: string; tags: string[] }
interface Menu { id: string; name: string; occasion: string; dishes: string[] }
interface MyDish { id: string; name: string; course: string; published: boolean }
interface GalleryDish { id: string; name: string; course: string; cuisine: string; tags: string[]; blurb?: string; author: string; householdId: string }

async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<{ status: number; data: T }> {
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as T };
}

// ── app state ──
let me: Me = { signedIn: false };
let plan: Plan | null | undefined; // undefined = not loaded yet, null = loaded and none exists
let myDishes: MyDish[] = [];
let catalog: { dishes: CatalogDish[]; menus: Menu[] } = { dishes: [], menus: [] };
let gallery: { dishes: GalleryDish[]; menus: Menu[] } = { dishes: [], menus: [] };
let busy = false;
let flash: { kind: 'ok' | 'err'; text: string } | null = null;

type Route = 'home' | 'discover' | 'dishes' | 'new' | 'public';
function currentRoute(): Route {
  if (/^\/p\/[a-z0-9]+$/.test(location.pathname)) return 'public';
  const h = location.hash.replace(/^#\/?/, '');
  return h === 'discover' ? 'discover' : h === 'dishes' ? 'dishes' : h === 'new' ? 'new' : 'home';
}

async function loadMe(): Promise<void> {
  const r = await api<Me>('/api/me');
  me = r.data;
}
async function loadPlan(): Promise<void> {
  if (!me.signedIn) return void (plan = null);
  const r = await api<Outcome>('/api/plan');
  plan = r.data.view ?? null;
}
async function loadMyDishes(): Promise<void> {
  if (!me.signedIn) return void (myDishes = []);
  const r = await api<{ dishes: MyDish[] }>('/api/dishes');
  myDishes = r.data.dishes ?? [];
}
async function loadCatalog(): Promise<void> {
  const r = await api<typeof catalog>('/api/catalog');
  catalog = r.data;
}
async function loadGallery(): Promise<void> {
  const r = await api<typeof gallery>('/api/discover');
  gallery = r.data;
}

function setFlash(kind: 'ok' | 'err', text: string): void {
  flash = { kind, text };
  render();
  setTimeout(() => {
    if (flash?.text === text) {
      flash = null;
      render();
    }
  }, 4000);
}

// ── layout ──
function header(): HTMLElement {
  const tabs = el(
    'nav',
    { class: 'tabs' },
    linkTab('#/', 'My kitchen', currentRoute() === 'home'),
    linkTab('#/new', 'Plan a meal', currentRoute() === 'new'),
    linkTab('#/dishes', 'My dishes', currentRoute() === 'dishes'),
    linkTab('#/discover', 'Discover', currentRoute() === 'discover'),
  );
  const userBit = me.signedIn
    ? el('div', { class: 'user-chip' }, `${esc(me.username ?? '')}`, signOutBtn())
    : el('div', { class: 'row' }, linkBtn('Sign in', '#/'));
  return el(
    'header',
    { class: 'top' },
    el('a', { class: 'brand', href: '/' }, el('div', { class: 'icon' }, '🔔'), 'Dinner Bell'),
    me.signedIn ? tabs : el('div', { class: 'spacer' }),
    userBit,
  );
}
function linkTab(href: string, label: string, active: boolean): HTMLElement {
  return el('a', { href, class: active ? 'active' : '' }, label);
}
function linkBtn(label: string, href: string): HTMLElement {
  return el('a', { href, class: 'btn primary' }, label);
}
function signOutBtn(): HTMLElement {
  const b = el('button', { class: 'btn ghost' }, 'Sign out');
  b.addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    me = { signedIn: false };
    plan = undefined;
    location.hash = '';
    await boot();
  });
  return b;
}

// ── landing / auth ──
function landing(): HTMLElement {
  const authCard = el('div', { class: 'card auth-card' });
  let mode: 'signin' | 'signup' = 'signin';
  const err = el('div', {});
  const draw = () => {
    const username = el('input', { placeholder: 'yourname', autocomplete: 'username' }) as HTMLInputElement;
    const password = el('input', { type: 'password', placeholder: '••••••••', autocomplete: mode === 'signin' ? 'current-password' : 'new-password' }) as HTMLInputElement;
    const submit = el('button', { class: 'btn primary block' }, mode === 'signin' ? 'Sign in' : 'Create account');
    const form = el(
      'form',
      {},
      el('div', { class: 'field' }, el('label', {}, 'Username'), username),
      el('div', { class: 'field' }, el('label', {}, 'Password'), password),
      submit,
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submit.setAttribute('disabled', 'true');
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const r = await api<{ error?: string }>(`/api/${mode}`, { method: 'POST', body: { username: username.value, password: password.value, tz } });
      if (r.status !== 200) {
        err.replaceChildren(el('div', { class: 'err-box' }, r.data.error ?? 'Something went wrong.'));
        submit.removeAttribute('disabled');
        return;
      }
      await boot();
    });
    const signInTab = el('button', { type: 'button', class: mode === 'signin' ? 'on' : '' }, 'Sign in');
    const signUpTab = el('button', { type: 'button', class: mode === 'signup' ? 'on' : '' }, 'Create account');
    signInTab.addEventListener('click', () => {
      mode = 'signin';
      draw();
    });
    signUpTab.addEventListener('click', () => {
      mode = 'signup';
      draw();
    });
    authCard.replaceChildren(el('div', { class: 'auth-tabs' }, signInTab, signUpTab), err, form);
  };
  draw();

  return el(
    'div',
    {},
    el(
      'div',
      { class: 'hero' },
      el('h1', {}, '🔔 Dinner Bell'),
      el('p', { class: 'lead' }, 'Plan a multi-dish meal so every dish lands hot at the same time — and watch it replan live, out loud, when the turkey runs long.'),
    ),
    authCard,
    el(
      'div',
      { class: 'features' },
      el('div', { class: 'card' }, el('b', {}, 'It actually schedules'), el('div', { class: 'muted' }, 'A real backward-scheduling engine handles one oven, contradictory dish timings, and resting windows — not a checklist.')),
      el('div', { class: 'card' }, el('b', {}, 'Replans as you cook'), el('div', { class: 'muted' }, `Say the turkey needs 20 more minutes and every downstream dish moves, instantly.`)),
      el('div', { class: 'card' }, el('b', {}, 'Build on other people’s dishes'), el('div', { class: 'muted' }, 'Browse the public gallery, fork a dish into your kitchen, make it yours.')),
    ),
  );
}

// ── "plan a meal" form ──
function planForm(): HTMLElement {
  const meal = el('input', { placeholder: 'e.g. Thanksgiving, or turkey, mashed potatoes, pie' }) as HTMLInputElement;
  const serveTime = el('input', { placeholder: 'e.g. 5pm thursday' }) as HTMLInputElement;
  const guests = el('input', { type: 'number', min: '1', max: '60', value: '8' }) as HTMLInputElement;
  const kitchenKnown = me.household?.kitchenKnown;
  const cooks = el('input', { type: 'number', min: '1', max: '6', value: String(me.household?.kitchen.cooks ?? 1) }) as HTMLInputElement;
  const ovens = el('input', { type: 'number', min: '1', max: '3', value: String(me.household?.kitchen.ovens ?? 1) }) as HTMLInputElement;
  const err = el('div', {});
  const menuChips = el(
    'div',
    { class: 'row', style: 'margin-bottom:14px' },
    ...catalog.menus.slice(0, 8).map((m) => {
      const b = el('button', { type: 'button', class: 'tag' }, m.occasion);
      b.addEventListener('click', () => (meal.value = m.occasion));
      return b;
    }),
  );
  const submit = el('button', { class: 'btn primary block' }, 'Build the plan');
  const form = el(
    'form',
    { class: 'card' },
    el('h2', {}, 'What are you cooking?'),
    menuChips,
    el('div', { class: 'field' }, el('label', {}, 'Occasion or dishes'), meal),
    el('div', { class: 'field' }, el('label', {}, 'Serve time'), serveTime),
    el('div', { class: 'field' }, el('label', {}, 'Guests'), guests),
    ...(kitchenKnown
      ? []
      : [
          el('div', { class: 'field' }, el('label', {}, 'Cooks in the kitchen'), cooks),
          el('div', { class: 'field' }, el('label', {}, 'Ovens available'), ovens),
        ]),
    err,
    submit,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!meal.value.trim() || !serveTime.value.trim()) {
      err.replaceChildren(el('div', { class: 'err-box' }, 'Tell me what you’re cooking and when it should be ready.'));
      return;
    }
    submit.setAttribute('disabled', 'true');
    const body: Record<string, unknown> = { meal: meal.value, serve_time: serveTime.value, guests: Number(guests.value) };
    if (!kitchenKnown) {
      body.cooks = Number(cooks.value);
      body.ovens = Number(ovens.value);
    }
    const r = await api<Outcome>('/api/plan', { method: 'POST', body });
    submit.removeAttribute('disabled');
    if (r.data.isError || (r.data.needsInput && !r.data.view)) {
      err.replaceChildren(el('div', { class: 'err-box' }, r.data.text));
      return;
    }
    setFlash('ok', r.data.text);
    location.hash = '';
    await refreshAll();
  });
  return form;
}

// ── dashboard (signed in, has an active plan) ──
function dashboard(): HTMLElement {
  if (plan === undefined) return el('div', { class: 'card' }, 'Loading…');
  if (plan === null) {
    return el('div', {}, el('div', { class: 'card' }, el('h2', {}, 'No meal planned yet'), el('p', { class: 'lead' }, 'Tell Dinner Bell what you’re cooking and when, and it’ll build a timeline that gets everything to the table together.'), el('a', { href: '#/new', class: 'btn primary' }, 'Plan a meal')));
  }
  const p = plan;
  const color = (id: string) => PALETTE[Math.max(0, p.dishes.findIndex((d) => d.id === id)) % PALETTE.length];
  const state = oneOf(p.state, ['on_track', 'tight', 'late', 'impossible'], 'tight');
  const chip = el('span', { class: `chip ${state}` }, STATE_LABEL[state] ?? state);

  const live = p.tasks.filter((t) => !t.before_cooking_window);
  const running = live.filter((t) => t.status === 'running');
  const pending = live.filter((t) => t.status === 'pending').sort((a, b) => a.start.localeCompare(b.start));
  const due = pending[0];

  const act = async (dish: string, status: string, step?: string): Promise<void> => {
    if (busy) return;
    busy = true;
    render();
    const r = await api<Outcome>('/api/plan/report', { method: 'POST', body: { dish, status, step } });
    busy = false;
    if (r.data.isError) setFlash('err', r.data.text);
    else setFlash('ok', r.data.text);
    plan = r.data.view ?? plan;
    render();
  };

  const nextCard = due
    ? el(
        'div',
        { class: 'card' },
        el('h2', {}, 'Up next'),
        el('div', { class: 'next-when' }, due.start_local),
        el('div', { class: 'next-what' }, due.step),
        el('div', { class: 'next-meta' }, `${due.dish} · ${due.start_local}–${due.end_local}`),
        el(
          'div',
          { class: 'row', style: 'margin-top:14px' },
          btn('Started', 'primary', () => act(due.dish, 'started', due.step)),
          btn('Done', 'ghost', () => act(due.dish, 'done', due.step)),
        ),
      )
    : el('div', { class: 'card' }, el('h2', {}, 'All done'), 'Everything is finished. Enjoy dinner! 🍽️');

  const runningCard = running.length
    ? el(
        'div',
        { class: 'card' },
        el('h2', {}, 'In progress'),
        ...running.map((t) =>
          el(
            'div',
            { class: 'dish-row', style: `border-left:4px solid ${color(t.dish_id)}` },
            el('div', { class: 'name' }, `${t.dish} — ${t.step}`),
            btn('Done', 'ghost', () => act(t.dish, 'done', t.step)),
            btn('+15 min', 'ghost', () => act(t.dish, 'running_long', t.step)),
          ),
        ),
      )
    : null;

  const list = el(
    'div',
    { class: 'timeline-list' },
    ...live
      .sort((a, b) => a.start.localeCompare(b.start))
      .map((t) =>
        el(
          'div',
          { class: `timeline-row ${t.status}` },
          el('span', { class: 'task-time' }, `${t.start_local}–${t.end_local}`),
          el('span', {}, el('b', { style: `color:${color(t.dish_id)}` }, t.dish + ' '), t.step),
          el('span', { class: 'tag' }, t.status),
        ),
      ),
  );

  const ahead = p.ahead_of_time.length
    ? el(
        'div',
        { class: 'card' },
        el('h2', {}, 'Ahead of time'),
        ...p.ahead_of_time.slice(0, 6).map((a) => el('div', { class: 'dish-row' }, el('span', { class: 'name' }, a.text), el('span', { class: 'muted' }, a.when ?? ''))),
      )
    : null;

  const tip = p.suggestions[0] ? el('div', { class: 'err-box', style: 'background:var(--panel2);border-color:var(--line);color:var(--mut)' }, `💡 ${p.suggestions[0].message}`) : null;

  const shareRow = el('div', { class: 'share-box' });
  const drawShare = (slug?: string) => {
    if (slug) {
      const url = `${location.origin}/p/${slug}`;
      const input = el('input', { value: url, readonly: 'true' }) as HTMLInputElement;
      const copy = btn('Copy', 'ghost', () => {
        navigator.clipboard?.writeText(url).catch(() => {});
        setFlash('ok', 'Copied.');
      });
      const off = btn('Unshare', 'danger', async () => {
        await api('/api/plan/unshare', { method: 'POST' });
        drawShare(undefined);
      });
      shareRow.replaceChildren(input, copy, off);
    } else {
      const share = btn('Share this plan', 'ghost', async () => {
        const r = await api<Outcome>('/api/plan/share', { method: 'POST' });
        drawShare((r.data.data?.slug as string) ?? undefined);
      });
      shareRow.replaceChildren(share);
    }
  };
  drawShare(undefined);

  const endBtn = btn('End this plan', 'ghost', async () => {
    if (!confirm('End the current meal plan?')) return;
    await api('/api/plan/cancel', { method: 'POST' });
    plan = null;
    render();
  });

  return el(
    'div',
    {},
    el(
      'div',
      { class: 'card' },
      el('div', { class: 'row', style: 'justify-content:space-between;align-items:center' }, el('h1', { style: 'margin:0' }, `Dinner at ${p.serve_target_local}`), chip),
      el('div', { class: 'muted' }, `${p.serve_target_day} · ${p.guests} guests · ${p.cooks} ${p.cooks === 1 ? 'cook' : 'cooks'}${state === 'late' ? ` · ready ${p.achievable_local}` : ''}`),
      tip,
    ),
    nextCard,
    runningCard,
    el('div', { class: 'card' }, el('h2', {}, 'Full timeline'), list),
    ahead,
    el('div', { class: 'card' }, el('h2', {}, 'Share'), shareRow),
    el('div', { style: 'text-align:right' }, endBtn),
  );
}
function btn(label: string, cls: string, onClick: () => void): HTMLElement {
  const b = el('button', { type: 'button', class: `btn ${cls}` }, label);
  if (busy) b.setAttribute('disabled', 'true');
  b.addEventListener('click', onClick);
  return b;
}

// ── my dishes ──
function dishesPage(): HTMLElement {
  const nameI = el('input', { placeholder: "Grandma's mac and cheese" }) as HTMLInputElement;
  const courseI = el('select', {}) as HTMLSelectElement;
  for (const c of ['main', 'side', 'bread', 'dessert', 'starter']) courseI.append(el('option', { value: c }, c));
  const methodI = el('select', {}) as HTMLSelectElement;
  for (const m of ['oven', 'stovetop', 'no cooking']) methodI.append(el('option', { value: m }, m));
  const cookI = el('input', { type: 'number', min: '0', max: '600', value: '30' }) as HTMLInputElement;
  const prepI = el('input', { type: 'number', min: '0', max: '300', value: '15' }) as HTMLInputElement;
  const err = el('div', {});
  const submit = el('button', { class: 'btn primary' }, 'Add to my kitchen');
  const form = el(
    'form',
    { class: 'card' },
    el('h2', {}, 'Teach Dinner Bell a recipe'),
    el('div', { class: 'field' }, el('label', {}, 'Name'), nameI),
    el('div', { class: 'row' }, el('div', { class: 'field', style: 'flex:1' }, el('label', {}, 'Course'), courseI), el('div', { class: 'field', style: 'flex:1' }, el('label', {}, 'Cooks'), methodI)),
    el('div', { class: 'row' }, el('div', { class: 'field', style: 'flex:1' }, el('label', {}, 'Cook minutes'), cookI), el('div', { class: 'field', style: 'flex:1' }, el('label', {}, 'Prep minutes'), prepI)),
    err,
    submit,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!nameI.value.trim()) {
      err.replaceChildren(el('div', { class: 'err-box' }, 'Give it a name.'));
      return;
    }
    submit.setAttribute('disabled', 'true');
    const r = await api<Outcome>('/api/dishes', {
      method: 'POST',
      body: { name: nameI.value, course: courseI.value, method: methodI.value, cook_minutes: Number(cookI.value), prep_minutes: Number(prepI.value), hands_off: true, make_ahead: false },
    });
    submit.removeAttribute('disabled');
    if (r.data.isError) return void err.replaceChildren(el('div', { class: 'err-box' }, r.data.text));
    setFlash('ok', r.data.text);
    nameI.value = '';
    await loadMyDishes();
    render();
  });

  const rows = myDishes.length
    ? myDishes.map((d) =>
        el(
          'div',
          { class: 'dish-row' },
          el('span', { class: 'name' }, d.name),
          el('span', { class: 'tag' }, d.course),
          btn(d.published ? 'Published ✓' : 'Publish', d.published ? 'ghost' : 'primary', async () => {
            await api(`/api/dishes/${encodeURIComponent(d.id)}/${d.published ? 'unpublish' : 'publish'}`, { method: 'POST' });
            await loadMyDishes();
            render();
          }),
        ),
      )
    : [el('div', { class: 'muted' }, 'No dishes yet — add one below, or fork one from Discover.')];

  return el('div', {}, form, el('div', { class: 'card' }, el('h2', {}, 'My dishes'), el('div', { class: 'dish-list' }, ...rows)));
}

// ── discover ──
function discoverPage(): HTMLElement {
  const cards = gallery.dishes.length
    ? gallery.dishes.map((d) =>
        el(
          'div',
          { class: 'card gallery-card' },
          el('div', { class: 'top-row' }, el('b', {}, d.name), el('span', { class: 'tag' }, d.course)),
          el('div', { class: 'author' }, `by ${esc(d.author)}`),
          d.blurb ? el('div', { class: 'blurb' }, d.blurb) : null,
          el('div', { class: 'tag-row' }, el('span', { class: 'tag' }, d.cuisine), ...d.tags.slice(0, 2).map((t) => el('span', { class: 'tag' }, t))),
          btn('Fork into my kitchen', 'primary', async () => {
            if (!me.signedIn) return void (location.href = '/');
            const r = await api<Outcome>(`/api/discover/${encodeURIComponent(d.householdId)}/${encodeURIComponent(d.id)}/fork`, { method: 'POST' });
            setFlash(r.data.isError ? 'err' : 'ok', r.data.text);
            await loadMyDishes();
          }),
        ),
      )
    : [el('div', { class: 'muted' }, 'No public dishes yet — be the first to publish one from "My dishes".')];
  return el('div', {}, el('div', { class: 'card' }, el('h1', { style: 'margin:0 0 4px' }, 'Discover'), el('p', { class: 'lead', style: 'margin:0' }, 'Dishes other cooks have published. Fork one into your own kitchen and build on it.')), el('div', { class: 'grid' }, ...cards));
}

// ── public read-only plan (/p/:slug) ──
async function publicPlanPage(): Promise<HTMLElement> {
  const slug = location.pathname.split('/')[2];
  const r = await api<{ view: Plan; householdName: string } | { error: string }>(`/api/public/${slug}`);
  if (r.status !== 200 || !('view' in r.data)) {
    return el('div', { class: 'card' }, el('h2', {}, 'This link isn’t available'), el('p', {}, 'The plan may have been unshared.'), el('a', { href: '/', class: 'btn primary' }, 'Plan your own meal'));
  }
  const p = r.data.view;
  const state = oneOf(p.state, ['on_track', 'tight', 'late', 'impossible'], 'tight');
  const color = (id: string) => PALETTE[Math.max(0, p.dishes.findIndex((d) => d.id === id)) % PALETTE.length];
  const list = p.tasks
    .filter((t) => !t.before_cooking_window)
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((t) => el('div', { class: `timeline-row ${t.status}` }, el('span', { class: 'task-time' }, `${t.start_local}–${t.end_local}`), el('span', {}, el('b', { style: `color:${color(t.dish_id)}` }, t.dish + ' '), t.step), el('span', { class: 'tag' }, t.status)));
  return el(
    'div',
    {},
    el(
      'div',
      { class: 'card' },
      el('div', { class: 'muted' }, `Shared by ${esc(r.data.householdName)}`),
      el('div', { class: 'row', style: 'justify-content:space-between;align-items:center' }, el('h1', { style: 'margin:0' }, `Dinner at ${p.serve_target_local}`), el('span', { class: `chip ${state}` }, STATE_LABEL[state] ?? state)),
      el('div', { class: 'muted' }, `${p.serve_target_day} · ${p.guests} guests · ${p.dishes.length} dishes`),
    ),
    el('div', { class: 'card' }, el('h2', {}, 'Timeline'), el('div', { class: 'timeline-list' }, ...list)),
    el('div', { class: 'card', style: 'text-align:center' }, el('p', { class: 'lead', style: 'margin:0 0 12px' }, 'Built with Dinner Bell.'), el('a', { href: '/', class: 'btn primary' }, 'Plan your own meal')),
  );
}

// ── router / render ──
async function refreshAll(): Promise<void> {
  await loadMe();
  await Promise.all([loadPlan(), loadMyDishes()]);
  render();
}

async function render(): Promise<void> {
  const route = currentRoute();
  const flashEl = flash ? el('div', { class: flash.kind === 'ok' ? 'ok-box' : 'err-box' }, flash.text) : null;

  if (route === 'public') {
    root.replaceChildren(el('div', { class: 'shell' }, flashEl, await publicPlanPage(), foot()));
    return;
  }
  if (!me.signedIn) {
    root.replaceChildren(el('div', { class: 'shell' }, header(), flashEl, landing(), foot()));
    return;
  }
  let body: HTMLElement;
  if (route === 'discover') body = discoverPage();
  else if (route === 'dishes') body = dishesPage();
  else if (route === 'new') body = planForm();
  else body = dashboard();
  root.replaceChildren(el('div', { class: 'shell' }, header(), flashEl, body, foot()));
}
function foot(): HTMLElement {
  return el('footer', { class: 'foot' }, 'Dinner Bell · also a real ', el('a', { href: '/sim' }, 'Alexa+ add-on'), ' · ', el('a', { href: 'https://github.com', target: '_blank', rel: 'noopener' }, 'source'));
}

window.addEventListener('hashchange', async () => {
  if (currentRoute() === 'discover' && !gallery.dishes.length) await loadGallery();
  await render();
});

async function boot(): Promise<void> {
  await loadMe();
  await loadCatalog();
  if (currentRoute() === 'public') return void render();
  if (me.signedIn) await Promise.all([loadPlan(), loadMyDishes()]);
  if (currentRoute() === 'discover') await loadGallery();
  await render();
}
void boot();
