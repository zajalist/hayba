import React from "react";
import { colors, fonts } from "@hayba/design-tokens";

const BEIGE = "#DED4C3";

export type PhaseStepId = "compose" | "boundaries" | "densities" | "simulate";

interface StepDef {
  id: PhaseStepId;
  label: string;
}

const STEPS: StepDef[] = [
  { id: "compose",    label: "Compose" },
  { id: "boundaries", label: "Boundaries" },
  { id: "densities",  label: "Densities" },
  { id: "simulate",   label: "Simulate" },
];

export interface PhaseStepsProps {
  /** The current step. Earlier steps render as 'done'; later as 'pending'. */
  current: PhaseStepId;
}

/**
 * Four-step indicator inspired by TE's bottom-panel wizard pips, but
 * stripped down: numbered pills in sentence case, current step in beige,
 * prior steps softly muted, future ones dimmed.
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
      }}
    >
      {STEPS.map((s, i) => {
        const isCurrent = i === currentIdx;
        const isDone = i < currentIdx;
        const num = String(i + 1).padStart(2, "0");
        const textColor =
          isCurrent ? BEIGE :
          isDone ? colors.textSecondary :
          colors.textMuted;
        const numColor =
          isCurrent ? BEIGE :
          isDone ? colors.borderSoft :
          colors.borderSoft;
        return (
          <React.Fragment key={s.id}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "0 12px",
                opacity: isCurrent || isDone ? 1 : 0.55,
              }}
            >
              <span style={{
                fontFamily: fonts.mono,
                fontSize: 11,
                color: numColor,
                letterSpacing: "0.01em",
              }}>
                {num}
              </span>
              <span style={{
                fontSize: 13,
                color: textColor,
                letterSpacing: "0.01em",
                fontWeight: isCurrent ? 500 : 400,
                whiteSpace: "nowrap",
              }}>
                {s.label}
              </span>
            </span>
            {i < STEPS.length - 1 && (
              <span style={{
                width: 12,
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
