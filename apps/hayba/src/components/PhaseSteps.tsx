import React from "react";
import { colors, fonts } from "@hayba/design-tokens";

const BEIGE = "#DED4C3";

export type PhaseStepId = "compose" | "boundaries" | "animate";

interface StepDef {
  id: PhaseStepId;
  label: string;
}

const STEPS: StepDef[] = [
  { id: "compose",    label: "Compose" },
  { id: "boundaries", label: "Boundaries" },
  { id: "animate",    label: "Animate" },
];

export interface PhaseStepsProps {
  /** The current step. Earlier steps render as 'done'; later as 'pending'. */
  current: PhaseStepId;
}

/**
 * Tiny three-step indicator inspired by TE's bottom-panel wizard pips, but
 * stripped down: `01 Compose · 02 Boundaries · 03 Animate` with the active
 * step in beige and previous steps softly muted.
 */
export default function PhaseSteps({ current }: PhaseStepsProps) {
  const currentIdx = STEPS.findIndex((s) => s.id === current);
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 0,
        height: "100%",
        fontFamily: fonts.sans,
        paddingLeft: 4,
      }}
    >
      {STEPS.map((s, i) => {
        const isCurrent = i === currentIdx;
        const isDone = i < currentIdx;
        const num = String(i + 1).padStart(2, "0");
        const color =
          isCurrent ? BEIGE :
          isDone ? colors.textSecondary :
          colors.textMuted;
        const numColor =
          isCurrent ? colors.accent :
          isDone ? colors.textMuted :
          colors.borderSoft;
        return (
          <React.Fragment key={s.id}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "0 10px",
                opacity: isCurrent || isDone ? 1 : 0.65,
              }}
            >
              <span style={{
                fontFamily: fonts.mono,
                fontSize: 9,
                color: numColor,
                letterSpacing: "0.04em",
              }}>
                {num}
              </span>
              <span style={{
                fontSize: 11,
                color,
                letterSpacing: "0.02em",
                fontWeight: isCurrent ? 500 : 400,
                whiteSpace: "nowrap",
              }}>
                {s.label}
              </span>
            </span>
            {i < STEPS.length - 1 && (
              <span style={{
                width: 14,
                height: 1,
                background: i < currentIdx ? colors.borderSoft : colors.borderMid,
              }} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
