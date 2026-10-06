"use client";

import { useEffect, useState } from "react";
import { money } from "@/lib/history";
import { FAST_ACCEPT_SECONDS, formatSeconds, type Scoreboard as Board } from "@/lib/scoreboard";

/**
 * The Stats tab: today's numbers, a goal, a streak, a level and badges
 * (lib/scoreboard.ts decides all of it; this only draws).
 *
 * Fetched when the tab is open and refreshed every minute while it stays
 * open - it is a scoreboard, not the order list, so it does not ride the
 * live poll. Big, few numbers, readable from the pass; the CRM's cards and
 * pills, no new colours.
 */
const REFRESH_MS = 60_000;

export default function Scoreboard() {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/dashboard/scoreboard", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok || !data?.scoreboard) {
          setError(data?.error ?? "Could not load stats.");
          return;
        }
        setError(null);
        setBoard(data.scoreboard);
      } catch {
        if (!cancelled) setError("Could not reach the server.");
      }
    };
    load();
    const t = window.setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  if (!board) {
    return (
      <div className="score">
        <p className="app-empty" role="status">{error ?? "Loading stats…"}</p>
      </div>
    );
  }

  const { today, goal, streak, points, week, badges } = board;
  const goalPct = Math.min(1, goal.target > 0 ? goal.done / goal.target : 0);
  const levelPct = points.perLevel > 0 ? points.intoLevel / points.perLevel : 0;
  const weekMax = Math.max(1, ...week.map((d) => Math.max(d.count, d.lastWeek)));
  const earned = badges.filter((b) => b.earned).length;

  return (
    <div className="score">
      {error && <p className="score-stale" role="status">{error} Showing the last numbers we had.</p>}

      <section className="score-hero">
        <GoalRing pct={goalPct} done={goal.done} target={goal.target} />
        <div className="score-hero-text">
          <div className="score-kicker">Today&apos;s goal</div>
          <div className="score-hero-line">
            {goal.done >= goal.target ? (
              <>Goal hit. <span className="score-good">Keep it rolling.</span></>
            ) : (
              <>
                <span className="num">{goal.target - goal.done}</span> more {goal.target - goal.done === 1 ? "order" : "orders"} to go
              </>
            )}
          </div>
          <div className="score-sub">{goal.basis}</div>
        </div>
      </section>

      <section className="score-tiles">
        <Tile label="Orders today" value={String(today.orders)} />
        <Tile label="Sales today" value={money(today.sales)} />
        <Tile
          label="Typical accept"
          value={today.typicalAcceptSeconds === null ? "—" : formatSeconds(today.typicalAcceptSeconds)}
          tone={today.typicalAcceptSeconds === null ? undefined : today.typicalAcceptSeconds <= FAST_ACCEPT_SECONDS ? "good" : "warn"}
          note={today.fastestAcceptSeconds === null ? undefined : `Fastest ${formatSeconds(today.fastestAcceptSeconds)}`}
        />
        <Tile
          label="Under 2 min"
          value={today.fastShare === null ? "—" : `${Math.round(today.fastShare * 100)}%`}
          tone={today.fastShare === null ? undefined : today.fastShare >= 0.9 ? "good" : today.fastShare >= 0.6 ? undefined : "warn"}
          note={today.accepted ? `of ${today.accepted} accepted` : undefined}
        />
      </section>

      <section className="score-row">
        <div className="score-card score-streak">
          <div className="score-kicker">Fast-accept streak</div>
          <div className="score-big num">{streak.current}</div>
          <div className="score-sub">
            in a row under 2 min · best <span className="num">{streak.best}</span>
          </div>
        </div>

        <div className="score-card score-level">
          <div className="score-kicker">Kitchen level · this month</div>
          <div className="score-level-line">
            <span className="score-level-n num">{points.level}</span>
            <span className="score-level-name">{points.levelName}</span>
            <span className="score-today num">+{points.today} today</span>
          </div>
          <div className="score-bar" aria-hidden="true">
            <span style={{ width: `${Math.round(levelPct * 100)}%` }} />
          </div>
          <div className="score-sub">
            <span className="num">{points.intoLevel}</span> / <span className="num">{points.perLevel}</span> points to the next level ·
            10 per order, +5 under 1 min, +3 under 2 min
          </div>
        </div>
      </section>

      <section className="score-card">
        <div className="score-kicker">This week vs last week</div>
        <div className="score-week" role="img" aria-label="Orders per day this week, with the same day last week">
          {week.map((d) => (
            <div key={d.key} className={`score-week-day${d.label === "Today" ? " today" : ""}`}>
              <div className="score-week-bars">
                <span className="score-week-last" style={{ height: `${(d.lastWeek / weekMax) * 100}%` }} title={`Last week: ${d.lastWeek}`} />
                <span className="score-week-this" style={{ height: `${(d.count / weekMax) * 100}%` }} title={`${d.count} orders`} />
              </div>
              <span className="score-week-n num">{d.count}</span>
              <span className="score-week-label">{d.label === "Yesterday" ? "Yest." : d.label}</span>
            </div>
          ))}
        </div>
        <div className="score-legend">
          <span><i className="score-dot this" /> This week</span>
          <span><i className="score-dot last" /> Same day last week</span>
        </div>
      </section>

      <section className="score-card">
        <div className="score-kicker">
          Badges · <span className="num">{earned}</span> of <span className="num">{badges.length}</span> earned
        </div>
        <div className="score-badges">
          {badges.map((b) => (
            <div key={b.key} className={`score-badge${b.earned ? " earned" : ""}`}>
              <div className="score-badge-top">
                <span className="score-badge-mark" aria-hidden="true">{b.earned ? "✓" : ""}</span>
                <span className="score-badge-label">{b.label}</span>
              </div>
              <div className="score-badge-rule">{b.rule}</div>
              {!b.earned && (
                <>
                  <div className="score-bar small" aria-hidden="true">
                    <span style={{ width: `${Math.round(b.progress * 100)}%` }} />
                  </div>
                  <div className="score-badge-progress num">{b.progressLabel}</div>
                </>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Tile({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "good" | "warn" }) {
  return (
    <div className={`score-tile${tone ? ` ${tone}` : ""}`}>
      <div className="score-kicker">{label}</div>
      <div className="score-tile-value num">{value}</div>
      {note && <div className="score-sub">{note}</div>}
    </div>
  );
}

function GoalRing({ pct, done, target }: { pct: number; done: number; target: number }) {
  const r = 46;
  const c = 2 * Math.PI * r;
  return (
    <svg className={`score-ring${pct >= 1 ? " hit" : ""}`} viewBox="0 0 120 120" role="img" aria-label={`${done} of ${target} orders`}>
      <circle className="score-ring-track" cx="60" cy="60" r={r} />
      <circle
        className="score-ring-fill"
        cx="60"
        cy="60"
        r={r}
        strokeDasharray={c}
        strokeDashoffset={c * (1 - pct)}
        transform="rotate(-90 60 60)"
      />
      <text x="60" y="58" className="score-ring-n">{done}</text>
      <text x="60" y="80" className="score-ring-of">of {target}</text>
    </svg>
  );
}
