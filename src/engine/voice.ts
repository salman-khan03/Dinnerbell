/**
 * Spoken-language rendering. Alexa+ reads tool results aloud, so every
 * sentence here is short, contains no markup, no URLs and no symbols, and
 * puts the most important thing first.
 */
import type { Agenda, ScheduleDiff } from './progress.js';
import type { Schedule, ScheduledTask } from './types.js';
import { humanList, sayClock, sayDuration } from './time.js';

const lower = (s: string): string => (s ? s[0].toLowerCase() + s.slice(1) : s);

/** Trim a label into something that can follow "you'll want to". */
export function sayTask(t: ScheduledTask): string {
  return lower(t.label);
}

export function sayState(s: Schedule, tz: string): string {
  switch (s.state) {
    case 'on_track':
      return s.bufferMin >= 60
        ? `You're on track with plenty of slack.`
        : `You're on track with about ${sayDuration(s.bufferMin)} of slack.`;
    case 'tight':
      return `It's tight but doable, with ${s.bufferMin > 0 ? sayDuration(s.bufferMin) : 'no'} of slack.`;
    case 'late':
      return `The earliest you can serve is ${sayClock(s.achievableServeMin, tz)}, which is ${sayDuration(-s.bufferMin)} after your target.`;
    default:
      return `This is more than the kitchen can handle in a sensible time.`;
  }
}

export function sayPlanCreated(
  s: Schedule,
  ctx: { tz: string; guests: number; dishCount: number },
): string {
  const { tz } = ctx;
  const first = s.tasks
    .filter((t) => t.status === 'pending' && !t.preWork)
    .sort((a, b) => a.startMin - b.startMin)[0];
  const parts: string[] = [];
  const target = sayClock(s.requestedServeMin, tz);
  if (s.state === 'late') {
    parts.push(`I planned ${ctx.dishCount} dishes for ${ctx.guests}, but ${sayState(s, tz).toLowerCase()}`);
  } else {
    parts.push(`Your ${ctx.dishCount}-dish meal for ${ctx.guests} will be ready at ${target}. ${sayState(s, tz)}`);
  }
  if (first) parts.push(`Your first step is at ${sayClock(first.startMin, tz)}: ${sayTask(first)}.`);
  if (s.prework.length) {
    const scheduled = s.prework.filter((p) => p.key).length;
    if (scheduled) parts.push(`There ${scheduled === 1 ? 'is 1 thing' : `are ${scheduled} things`} to do ahead of time.`);
  }
  const top = s.insights[0];
  if (top) parts.push(top.message);
  return parts.join(' ');
}

export function sayAgenda(a: Agenda, s: Schedule, tz: string, nowMin: number): string {
  const parts: string[] = [];
  if (a.running.length) {
    const r = a.running[0];
    const left = Math.max(0, r.endMin - nowMin);
    parts.push(
      a.running.length === 1
        ? `${r.dishName} is in progress, about ${sayDuration(left)} left.`
        : `${humanList(a.running.map((x) => x.dishName.toLowerCase()))} are in progress.`,
    );
  }
  if (a.startNow.length) {
    const items = a.startNow.slice(0, 3).map(sayTask);
    parts.push(`Right now: ${humanList(items)}.`);
    if (a.startNow.length > 3) parts.push(`Plus ${a.startNow.length - 3} more.`);
  }
  if (a.upNext.length) {
    const n = a.upNext[0];
    parts.push(`At ${sayClock(n.startMin, tz)}: ${sayTask(n)}.`);
  }
  if (!a.running.length && !a.startNow.length && !a.upNext.length) {
    const nextTask = s.tasks.filter((t) => t.status === 'pending' && !t.preWork).sort((x, y) => x.startMin - y.startMin)[0];
    parts.push(
      nextTask
        ? `Nothing to do for ${sayDuration(nextTask.startMin - nowMin)}. Next up at ${sayClock(nextTask.startMin, tz)}: ${sayTask(nextTask)}.`
        : `Everything is done. Enjoy dinner!`,
    );
  }
  return parts.join(' ');
}

export function sayReport(
  verb: string,
  dishName: string,
  s: Schedule,
  d: ScheduleDiff,
  tz: string,
): string {
  const parts = [`Got it, ${verb}.`];
  if (s.state === 'late') parts.push(sayState(s, tz));
  else if (d.moved.length >= 2) {
    const first = d.moved[0];
    parts.push(`I moved ${d.moved.length} steps. Next: ${sayTask({ label: first.label } as ScheduledTask)} at ${sayClock(first.to, tz)}.`);
  } else if (d.moved.length === 1) {
    const m = d.moved[0];
    parts.push(`I moved ${lower(m.label)} to ${sayClock(m.to, tz)}.`);
  } else {
    parts.push(`Nothing else has to move.`);
  }
  if (s.state !== 'late') {
    if (d.bufferDelta <= -10) parts.push(`Your slack is down to ${s.bufferMin > 0 ? sayDuration(s.bufferMin) : 'nothing'}.`);
    else if (s.state === 'tight') parts.push(`It's tight, so keep moving.`);
    else parts.push(`Dinner is still on for ${sayClock(s.requestedServeMin, tz)}.`);
  }
  if (s.state === 'late' || s.state === 'tight') {
    const i = s.insights[0];
    if (i) parts.push(i.message);
  }
  void dishName;
  return parts.join(' ');
}

export function sayOverview(s: Schedule, tz: string): string {
  const pending = s.tasks.filter((t) => t.status === 'pending' && !t.preWork);
  const first = pending[0];
  const last = pending[pending.length - 1];
  if (!first) return 'Everything is done.';
  return `${pending.length} steps between ${sayClock(first.startMin, tz)} and ${sayClock(last.endMin, tz)}, ready at ${sayClock(s.achievableServeMin, tz)}. ${sayState(s, tz)}`;
}
