import Image from "next/image";
import type { CSSProperties } from "react";
import {
  BookOpen,
  CalendarDays,
  Flag,
  Goal,
  MessageCircle,
  Shield,
  Target,
  TrendingUp,
  Volleyball,
} from "lucide-react";
import type { ReportViewModel, ReportMeasurementSeries } from "@/domain/report";
import { reportPresentation } from "@/services/reports/report-presentation";
import { developmentPriorities } from "@/services/reports/report-priorities";
import "./professional-report.css";

const priorityIcons = [Target, TrendingUp, Flag, Goal];

export function ReportPreview({
  model,
  variant = "document",
}: {
  model: ReportViewModel;
  variant?: "document" | "inline";
}) {
  const p = reportPresentation(model),
    a = p.attendance;
  const playerContext =
    [p.ageCategory, p.squad].filter(Boolean).join(" · ") || p.sport;
  const marked = a ? a.present + a.absent : 0;
  const percentage = marked
    ? Math.round((a!.present / marked) * 100)
    : undefined;
  const priorities = p.nextStep.trim() ? developmentPriorities(p.nextStep) : [];
  return (
    <article
      id={`report-${p.reportId}`}
      className={`development-report professional-report pr-${variant}`}
      aria-label={`Player development report: ${p.player}, ${p.periodLabel}`}
      style={
        p.brandAccent
          ? ({ "--pr-accent": p.brandAccent } as CSSProperties)
          : undefined
      }
    >
      <header className="pr-academy-header">
        <div className="pr-academy-brand">
          {p.logoData ? (
            <Image
              src={p.logoData}
              alt={`${p.academy} logo`}
              width={54}
              height={58}
              unoptimized
            />
          ) : (
            <span className="pr-academy-mark" aria-hidden="true">
              <Shield size={26} />
            </span>
          )}
          <div>
            <strong>{p.academy}</strong>
            <span>{p.labels?.title ?? "Player Development Report"}</span>
          </div>
        </div>
        <div className="pr-period">
          <strong>{p.periodLabel}</strong>
          <span>
            {p.demo ? "Fictional demonstration" : "Private player report"}
          </span>
        </div>
      </header>
      <section
        className="pr-player-header"
        aria-label={`Report player and period: ${p.player}, ${p.periodLabel}`}
      >
        {p.playerPhoto ? (
          <Image
            className="pr-player-photo"
            src={p.playerPhoto}
            alt={`${p.player} recorded profile photograph`}
            width={140}
            height={154}
            unoptimized
          />
        ) : (
          <div
            className="pr-player-initials"
            aria-label={`${p.player}: profile photograph not provided`}
          >
            {p.playerInitials}
          </div>
        )}
        <div className="pr-player-copy">
          <h2>{p.player}</h2>
          {variant === "inline" && p.labels?.title && <p>{p.labels.title}</p>}
          {playerContext && <p>{playerContext}</p>}
          {p.coach && <p>Coach: {p.coach}</p>}
          <div className="pr-status-row">
            <span
              className={`pr-status ${p.status === "Approved" ? "pr-approved" : "pr-draft"}`}
            >
              {p.status}
            </span>
            {p.reviewDateLabel && <span>Review date: {p.reviewDateLabel}</span>}
          </div>
        </div>
        <div
          className="pr-attendance-tile"
          role="group"
          aria-label={`Recorded attendance: ${p.player}, ${p.periodLabel}`}
        >
          <CalendarDays aria-hidden="true" size={22} />
          {a ? (
            <div>
              <strong>
                {a.present} / {marked}
              </strong>
              <span>Sessions attended</span>
              <small>
                {percentage === undefined
                  ? "No marked attendance basis"
                  : `${percentage}% attendance`}
              </small>
            </div>
          ) : (
            <div>
              <strong>—</strong>
              <span>Attendance</span>
              <small>Not recorded in this report</small>
            </div>
          )}
        </div>
      </section>
      {a && (
        <section className="pr-attendance" aria-label="Attendance breakdown">
          <dl className="pr-attendance-key">
            {(
              [
                ["Present", a.present, "present"],
                ["Absent", a.absent, "absent"],
                ["Excused", a.excused, "excused"],
                ["Unmarked", a.unmarked, "unmarked"],
              ] as const
            ).map(([label, count, tone]) => (
              <div key={label}>
                <dt>
                  <span className={`pr-dot pr-dot-${tone}`} />
                  {label}
                </dt>
                <dd>{count}</dd>
              </div>
            ))}
            <div className="pr-attendance-total">
              <dt>Completed roster sessions</dt>
              <dd>{a.total}</dd>
            </div>
          </dl>
          <p className="pr-method">
            Excused and unmarked sessions are shown separately and do not count
            as absences. Missing attendance is not treated as absence.
          </p>
        </section>
      )}
      <section className="pr-focus">
        <Target aria-hidden="true" size={22} />
        <div>
          <h3>{p.labels?.focus ?? "Training focus"}</h3>
          <p>{p.focus}</p>
          {p.reviewedReason && <span>{p.reviewedReason}</span>}
        </div>
      </section>
      <section className="pr-section pr-practice">
        <h3>
          <Goal aria-hidden="true" />
          {p.labels?.practised ?? "What we practised"}
        </h3>
        {p.activityCards.length ? (
          <>
            <div className="pr-activity-grid">
              {p.activityCards.slice(0, 4).map((activity, index) => (
                <div
                  className="pr-activity"
                  key={`${activity.drillId ?? activity.name}-${index}`}
                >
                  <Image
                    src={`/report-activities/${activity.illustrationKey}.png`}
                    alt=""
                    width={320}
                    height={200}
                    loading="eager"
                  />
                  <h4>{activity.name}</h4>
                  <p>{activity.purpose}</p>
                  {activity.activity && <span>{activity.activity}</span>}
                </div>
              ))}
            </div>
            <p className="pr-method">
              Generic activity illustrations — these do not depict this child or
              establish assessment evidence.
            </p>
            {p.activityCards.length > 4 && (
              <details className="pr-record-details">
                <summary>
                  {p.activityCards.length - 4} additional recorded activities
                </summary>
                {p.activityCards.slice(4).map((activity, index) => (
                  <div key={index}>
                    <h4>{activity.name}</h4>
                    <p>{activity.purpose}</p>
                    {activity.activity && <p>{activity.activity}</p>}
                  </div>
                ))}
              </details>
            )}
          </>
        ) : (
          <p className="pr-empty">
            {p.practised ||
              "No activity details were recorded for this report."}
          </p>
        )}
      </section>
      {!!p.coachEvaluation.length && (
        <section className="pr-section pr-evaluation">
          <h3>
            <MessageCircle aria-hidden="true" />
            Coach’s feedback
          </h3>
          <div className="pr-feedback-box">
            <RecordedNarrative
              title="Coach’s recorded evaluation"
              paragraphs={p.coachEvaluation}
            />
          </div>
        </section>
      )}
      <section className="pr-section pr-observations">
        <h3>
          <TrendingUp aria-hidden="true" />
          {p.labels?.observed ?? "What the coach observed"}
        </h3>
        {p.measurementSeries.length ? (
          p.measurementSeries.map((series, index) => (
            <MeasurementChart
              key={`${series.label}-${index}`}
              series={series}
            />
          ))
        ) : (
          <p className="pr-empty">
            No dated numerical measurements were recorded. No chart or progress
            score is inferred.
          </p>
        )}
        {!!p.observations.length && (
          <RecordedNarrative
            title="Recorded observations"
            paragraphs={p.observations}
          />
        )}
      </section>
      <section className="pr-section pr-next">
        <h3>
          <Target aria-hidden="true" />
          {p.labels?.next ?? "Development focus"}
        </h3>
        {priorities.length ? (
          <ul
            className={`pr-priorities pr-priorities-${priorities.length}`}
            aria-label={p.labels?.next ?? "Development focus"}
          >
            {priorities.map((priority, index) => {
              const Icon = priorityIcons[index % priorityIcons.length];
              return (
                <li key={index}>
                  <span className="pr-priority-icon" aria-hidden="true">
                    <Icon size={20} />
                  </span>
                  <span>{priority}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="pr-empty">
            No next development step has been recorded yet.
          </p>
        )}
        {p.nextDrill && <p>Assigned next drill: {p.nextDrill}</p>}
        {p.observationCriteria && (
          <p>Coach will observe: {p.observationCriteria}</p>
        )}
        <div className="pr-review-date">
          <CalendarDays aria-hidden="true" size={18} />
          <span>
            Review date
            <strong>
              {p.reviewDateLabel ||
                p.labels?.reviewPending ||
                "To be confirmed"}
            </strong>
          </span>
        </div>
      </section>
      <section className="pr-section pr-note">
        <h3>
          <BookOpen aria-hidden="true" />
          {p.labels?.closing ?? "Coach’s closing note"}
        </h3>
        <div className="pr-note-box">
          {p.note ? (
            <RecordedNarrative
              title="Complete coach’s note"
              paragraphs={[p.note]}
            />
          ) : (
            <p>No coach’s note was recorded.</p>
          )}
        </div>
        <span className="pr-method">
          Recorded coach guidance. No video or AI assessment.
        </span>
      </section>
      <footer className="pr-footer">
        <div className="pr-footer-brand">
          <span className="pr-footer-ball" aria-hidden="true">
            <Volleyball size={22} />
          </span>
          <div>
            <strong>{p.academy}</strong>
            <span>
              {p.labels?.privacy ?? "Private player development report"} ·
              External delivery: {p.externalDelivery}
            </span>
          </div>
        </div>
        <span>Powered by Sportozen</span>
      </footer>
    </article>
  );
}

function RecordedNarrative({
  title,
  paragraphs,
}: {
  title: string;
  paragraphs: string[];
}) {
  const length = paragraphs.reduce((total, text) => total + text.length, 0);
  if (length <= 750)
    return (
      <div className="pr-narrative">
        {paragraphs.map((text, index) => (
          <p key={index}>{text}</p>
        ))}
      </div>
    );
  return (
    <div className="pr-narrative">
      <p>{paragraphs[0].slice(0, 320).trimEnd()}…</p>
      <details className="pr-record-details">
        <summary>{title} — read complete recorded wording</summary>
        {paragraphs.map((text, index) => (
          <p key={index}>{text}</p>
        ))}
      </details>
    </div>
  );
}

function MeasurementChart({ series }: { series: ReportMeasurementSeries }) {
  const chunks = Array.from(
    { length: Math.ceil(series.points.length / 5) },
    (_, index) => series.points.slice(index * 5, index * 5 + 5),
  );
  const maximum = Math.max(
    1,
    ...series.points.map((point) => point.total ?? point.value),
  );
  const dateContext = series.points.every(
    (point) => point.dateKind === "REVIEWED",
  )
    ? "Reviewed observation dates shown; these are not confirmed session dates."
    : series.points.every((point) => point.dateKind === "SESSION")
      ? "Recorded session dates shown."
      : "Dates are shown only where recorded; unspecified observations remain separate.";
  const valueLabel = (point: ReportMeasurementSeries["points"][number]) =>
    series.unit === "ATTEMPTS"
      ? `${point.value}${point.total !== undefined ? `/${point.total}` : ""}`
      : `${point.value} s`;
  return (
    <figure className="pr-measurement">
      <figcaption>
        <strong>{series.label}</strong>
        <span>
          {series.unit === "ATTEMPTS"
            ? "Recorded successful attempts"
            : "Recorded defined-course time"}
        </span>
      </figcaption>
      {chunks.map((points, chunk) => (
        <div className="pr-chart-block" key={chunk}>
          <svg
            width="100%"
            height="210"
            role="img"
            aria-label={`${series.label}: ${points.map((point) => `${point.dateLabel}, ${valueLabel(point)}`).join("; ")}`}
          >
            {[0, 0.5, 1].map((fraction) => (
              <g key={fraction}>
                <line
                  x1="12%"
                  x2="95%"
                  y1={170 - fraction * 130}
                  y2={170 - fraction * 130}
                  stroke="#e4edf2"
                />
                <text
                  x="6%"
                  y={174 - fraction * 130}
                  textAnchor="middle"
                  className="pr-axis-label"
                >
                  {Number((maximum * fraction).toFixed(2))}
                </text>
              </g>
            ))}
            {points.map((point, index) => {
              const x =
                  points.length === 1
                    ? 53
                    : 17 + (index / (points.length - 1)) * 73,
                y = 170 - (point.value / maximum) * 130,
                previous = points[index - 1];
              return (
                <g key={`${point.dateLabel}-${index}`}>
                  {series.comparable && previous && (
                    <line
                      x1={`${17 + ((index - 1) / (points.length - 1)) * 73}%`}
                      y1={170 - (previous.value / maximum) * 130}
                      x2={`${x}%`}
                      y2={y}
                      stroke="#009d6c"
                      strokeWidth="2.5"
                    />
                  )}
                  <circle cx={`${x}%`} cy={y} r="4.5" fill="#009d6c" />
                  <text
                    x={`${x}%`}
                    y={y - 11}
                    textAnchor="middle"
                    className="pr-point-label"
                  >
                    {valueLabel(point)}
                  </text>
                  <text
                    x={`${x}%`}
                    y="197"
                    textAnchor="middle"
                    className="pr-date-label"
                  >
                    {point.date
                      ? point.dateLabel
                      : `Obs ${chunk * 5 + index + 1}`}
                  </text>
                </g>
              );
            })}
          </svg>
          <ul className="pr-measure-values">
            {points.map((point, index) => (
              <li key={index}>
                <span>{point.dateLabel}</span>
                <strong>{valueLabel(point)}</strong>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p className="pr-method">
        {dateContext}{" "}
        {series.comparable
          ? "Comparable recorded conditions. These counts describe this activity, not an ability score or prediction."
          : "These observations are not established as comparable; no progress trend is inferred."}
      </p>
    </figure>
  );
}
