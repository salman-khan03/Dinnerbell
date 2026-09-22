/**
 * The Dinner Bell timeline: an MCP App (a "View") that Alexa+ can show on a
 * screen. It receives the plan from the tool result, draws a lane per dish, and
 * calls the server back (report_progress) when the person taps a button, which
 * is the bidirectional part of MCP Apps.
 *
 * It never guesses the time: "now" comes from the plan itself, so the picture
 * is right in the simulator's fast-forwarded kitchen as well as in real time.
 */
import { App } from '@modelcontextprotocol/ext-apps';

interface Task {
  key: string;
  dish: string;
  dish_id: string;
  step: string;
  start: string;
  end: string;
  start_local: string;
  end_local: string;
  attention: 'full' | 'light' | 'none';
  appliance: string | null;
  status: 'pending' | 'running' | 'done' | 'skipped';
  before_cooking_window: boolean;
  notes: string[];
}
interface Plan {
  plan_id: string;
  state: 'on_track' | 'tight' | 'late' | 'impossible';
  headline: string;
  guests: number;
  cooks: number;
  ovens: number;
  timezone: string;
  now: string;
  serve_target: string;
  serve_target_local: string;
  serve_target_day: string;
  achievable: string;
  achievable_local: string;
  slack_minutes: number;
  dishes: { id: string; name: string; course: string }[];
  tasks: Task[];
  rests: { label: string; start: string; end: string }[];
  ahead_of_time: { text: string; when: string | null }[];
  warnings: string[];
  suggestions: { kind: string; message: string; saves_minutes: number | null }[];
  next_step: { start_local: string; step: string; dish: string } | null;
}

const PALETTE = ['#fb923c', '#4ade80', '#60a5fa', '#facc15', '#f472b6', '#2dd4bf', '#a78bfa', '#fb7185', '#a3e635', '#22d3ee'];
const STATE_LABEL: Record<Plan['state'], string> = { on_track: 'On track', tight: 'Tight but doable', late: 'Running late', impossible: 'Not enough time' };

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const ms = (iso: string): number => Date.parse(iso);
/** Only known values ever reach a class attribute, whatever the tool result says. */
const oneOf = <T extends string>(v: string, allowed: readonly T[], fallback: T): T => (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

function dur(min: number): string {
  const m = Math.round(Math.abs(min));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

let plan: Plan | null = null;
let selected: string | null = null;
let busy = false;
let app: App;

function fmt(tz: string, t: number, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).format(new Date(t)).replace(/ /g, ' ');
}
const clock = (tz: string, t: number): string => fmt(tz, t, { hour: 'numeric', minute: '2-digit' });

function render(): void {
  const root = $('#app');
  if (!plan) {
    root.innerHTML = `<div class="hero"><div class="big">🔔 Dinner Bell</div><div>Say “plan Thanksgiving dinner for 10 at 5” and I’ll time every dish so it all lands together.</div></div>`;
    return;
  }
  const p = plan;
  const tz = p.timezone;
  const now = ms(p.now);
  const serve = ms(p.serve_target);
  const achievable = ms(p.achievable);
  const color = (id: string): string => PALETTE[Math.max(0, p.dishes.findIndex((d) => d.id === id)) % PALETTE.length];

  const live = p.tasks.filter((t) => !t.before_cooking_window);
  const starts = live.map((t) => ms(t.start));
  const ends = live.map((t) => ms(t.end));
  const t0 = Math.min(...starts, now) - 15 * 60_000;
  const t1 = Math.max(...ends, serve) + 10 * 60_000;
  const span = Math.max(1, t1 - t0);
  const pct = (t: number): number => ((t - t0) / span) * 100;

  // Hour ticks
  const ticks: string[] = [];
  const firstHour = Math.ceil(t0 / 3_600_000) * 3_600_000;
  for (let t = firstHour; t < t1; t += 3_600_000) {
    ticks.push(`<div class="tick" style="left:${pct(t)}%">${esc(fmt(tz, t, { hour: 'numeric' }))}</div>`);
  }

  const lanes = p.dishes
    .map((d) => {
      const tasks = live.filter((t) => t.dish_id === d.id);
      if (!tasks.length) return '';
      const segs = tasks
        .map((t) => {
          const l = pct(ms(t.start));
          const w = Math.max(0.35, pct(ms(t.end)) - l);
          const cls = `seg ${oneOf(t.attention, ['full', 'light', 'none'], 'full')} ${oneOf(t.status, ['pending', 'running', 'done', 'skipped'], 'pending')}${selected === t.key ? ' sel' : ''}`;
          return `<button class="${cls}" data-key="${esc(t.key)}" style="left:${l}%;width:${w}%;background:${color(d.id)}" title="${esc(t.step)} · ${esc(t.start_local)}–${esc(t.end_local)}"><span class="t">${esc(t.step)}</span></button>`;
        })
        .join('');
      const rests = p.rests
        .filter((r) => tasks.some((t) => ms(t.end) === ms(r.start)) || tasks.some((t) => ms(t.start) === ms(r.end)))
        .map((r) => `<div class="rest" style="left:${pct(ms(r.start))}%;width:${Math.max(0, pct(ms(r.end)) - pct(ms(r.start)))}%">${esc(r.label)}</div>`)
        .join('');
      return `<div class="lane"><div class="name" title="${esc(d.name)}"><i style="background:${color(d.id)}"></i>${esc(d.name)}</div><div class="track">${rests}${segs}</div></div>`;
    })
    .join('');

  // Side: what to do now / next.
  const running = p.tasks.filter((t) => t.status === 'running');
  const pending = p.tasks.filter((t) => t.status === 'pending' && !t.before_cooking_window).sort((a, b) => ms(a.start) - ms(b.start));
  const due = pending.find((t) => ms(t.start) <= now + 5 * 60_000) ?? pending[0];
  const inMin = due ? Math.round((ms(due.start) - now) / 60_000) : 0;
  const when = due ? (inMin <= 5 ? 'Now' : due.start_local) : '';
  const whenSmall = due ? (inMin <= 5 ? '' : `in ${dur(inMin)}`) : '';

  const nextCard = due
    ? `<div class="card next"><h2>${inMin <= 5 ? 'Do this now' : 'Up next'}</h2>
        <div class="when">${esc(when)}<small>${esc(whenSmall)}</small></div>
        <div class="what">${esc(due.step)}</div>
        <div class="meta">${esc(due.dish)} · ${esc(due.start_local)}–${esc(due.end_local)}${due.notes.length ? ' · ' + esc(due.notes[0]) : ''}</div>
        <div class="row"><button class="btn primary" data-act="started" data-dish="${esc(due.dish)}" data-step="${esc(due.step)}" ${busy ? 'disabled' : ''}>Started</button>
        <button class="btn" data-act="done" data-dish="${esc(due.dish)}" data-step="${esc(due.step)}" ${busy ? 'disabled' : ''}>Done</button></div></div>`
    : `<div class="card next"><h2>All done</h2><div class="what">Everything is finished. Enjoy dinner! 🍽️</div></div>`;

  const runningCard = running.length
    ? `<div class="card"><h2>In progress</h2><div class="running">${running
        .map((t) => {
          const a = ms(t.start);
          const b = ms(t.end);
          const f = Math.min(100, Math.max(0, ((now - a) / Math.max(1, b - a)) * 100));
          const left = Math.max(0, Math.round((b - now) / 60_000));
          return `<div class="run"><b>${esc(t.dish)}</b><span>${left} min left</span><div class="bar"><i style="width:${f}%;background:${color(t.dish_id)}"></i></div>
            <div style="grid-column:1/-1;display:flex;gap:6px"><button class="btn" data-act="done" data-dish="${esc(t.dish)}" data-step="${esc(t.step)}" ${busy ? 'disabled' : ''}>Done</button>
            <button class="btn" data-act="running_long" data-min="15" data-dish="${esc(t.dish)}" data-step="${esc(t.step)}" ${busy ? 'disabled' : ''}>+15 min</button></div></div>`;
        })
        .join('')}</div></div>`
    : '';

  const ahead = p.ahead_of_time.length
    ? `<div class="card ahead"><h2>Ahead of time</h2><ul>${p.ahead_of_time
        .slice(0, 7)
        .map((a) => `<li><div>${esc(a.text)}${a.when ? `<span class="w">${esc(a.when)}</span>` : ''}</div></li>`)
        .join('')}</ul></div>`
    : '';

  const sel = selected ? p.tasks.find((t) => t.key === selected) : undefined;
  const detail = sel
    ? `<div class="detail"><b>${esc(sel.dish)}</b> · ${esc(sel.step)}<br>${esc(sel.start_local)} to ${esc(sel.end_local)}${sel.appliance ? ` · ${esc(sel.appliance.replace('-', ' '))}` : ''}${sel.notes.length ? ` · ${esc(sel.notes.join('. '))}` : ''}</div>`
    : '';

  const late = achievable > serve;
  const state = oneOf(p.state, ['on_track', 'tight', 'late', 'impossible'], 'tight');
  const chip = `<span class="chip ${state}">${STATE_LABEL[state]}${state === 'late' ? ` · ${esc(p.achievable_local)}` : p.slack_minutes > 0 ? ` · ${dur(p.slack_minutes)} slack` : ''}</span>`;
  const tips = [...p.suggestions.slice(0, 3).map((s) => `<span class="tip"><b>Tip</b> ${esc(s.message)}</span>`), ...p.warnings.slice(0, 1).map((w) => `<span class="tip">${esc(w)}</span>`)].join('');

  root.innerHTML = `
  <header>
    <div class="brand"><i>🔔</i>Dinner Bell</div>
    <div class="title">Dinner at ${esc(p.serve_target_local)}<small>${esc(p.serve_target_day)} · ${p.guests} guests · ${p.cooks} ${p.cooks === 1 ? 'cook' : 'cooks'}${late ? ` · ready ${esc(p.achievable_local)}` : ''}</small></div>
    <div class="spacer"></div>${chip}
    ${tips ? `<div class="tips">${tips}</div>` : ''}
  </header>
  <main>
    <div class="side">${nextCard}${runningCard}${ahead}</div>
    <div class="card gantt"><h2>Timeline · ${esc(clock(tz, now))} now</h2>
      <div class="gantt-inner" role="img" aria-label="Cooking timeline for ${p.dishes.length} dishes">
        <div class="axis">${ticks.join('')}</div>
        ${lanes}
        <div class="line now" style="left:calc(var(--lane) + (100% - var(--lane)) * ${pct(now) / 100})"><span>Now</span></div>
        <div class="line serve${pct(Math.max(serve, achievable)) > 86 ? ' edge' : ''}" style="left:calc(var(--lane) + (100% - var(--lane)) * ${pct(Math.max(serve, achievable)) / 100})"><span>${late ? 'Ready' : 'Dinner'} ${esc(clock(tz, Math.max(serve, achievable)))}</span></div>
      </div>
      <div class="legend"><span><b style="background:var(--accent)"></b>Needs you</span><span><b class="hatch"></b>Hands-off (oven, resting)</span><span><b style="border:1.5px dashed var(--mut);background:none"></b>Resting</span></div>
      ${detail}
    </div>
  </main>`;
}

async function act(el: HTMLElement): Promise<void> {
  if (busy || !plan) return;
  busy = true;
  render();
  try {
    const args: Record<string, unknown> = { dish: el.dataset.dish, status: el.dataset.act, step: el.dataset.step };
    if (el.dataset.min) args.minutes_left = Number(el.dataset.min);
    const res = await app.callServerTool({ name: 'report_progress', arguments: args });
    const next = (res.structuredContent as { plan?: Plan } | undefined)?.plan;
    if (next) plan = next;
  } catch (e) {
    console.error(e);
  } finally {
    busy = false;
    render();
  }
}

document.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest('[data-act],[data-key]') as HTMLElement | null;
  if (!t) return;
  if (t.dataset.act) void act(t);
  else if (t.dataset.key) {
    selected = selected === t.dataset.key ? null : t.dataset.key;
    render();
  }
});

function applyTheme(theme?: string): void {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
}

async function main(): Promise<void> {
  render();
  app = new App({ name: 'dinner-bell-timeline', version: '1.0.0' }, {}, { autoResize: false });
  app.ontoolresult = (result) => {
    const p = (result.structuredContent as { plan?: Plan } | undefined)?.plan;
    if (p) {
      plan = p;
      render();
    }
  };
  app.onhostcontextchanged = (ctx) => applyTheme((ctx as { theme?: string }).theme);
  try {
    await app.connect();
    applyTheme((app.getHostContext() as { theme?: string } | undefined)?.theme);
  } catch {
    /* Opened outside a host (for example as a preview): keep whatever we can render. */
  }
}

// A preview hook so the view can be developed outside a host.
(window as unknown as { __setPlan?: (p: Plan) => void }).__setPlan = (p) => {
  plan = p;
  render();
};

void main();
