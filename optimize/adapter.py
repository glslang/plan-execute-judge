"""GEPA adapter: candidates are {phase: prompt-template} dicts (a subset of
the pipeline's phases, e.g. plan + execute); evaluating a candidate runs the
full Node pipeline once per task and scores against the hidden checks."""

from __future__ import annotations

from typing import Any

from gepa.core.adapter import EvaluationBatch, GEPAAdapter

from pej import (
    EvalTask,
    RolloutConfig,
    RolloutResult,
    run_rollouts,
    validate_prompt_override,
)


class PejAdapter(GEPAAdapter[EvalTask, RolloutResult, dict[str, Any]]):
    def __init__(self, cfg: RolloutConfig):
        self.cfg = cfg

    def evaluate(
        self,
        batch: list[EvalTask],
        candidate: dict[str, str],
        capture_traces: bool = False,
    ) -> EvaluationBatch[RolloutResult, dict[str, Any]]:
        # Reject candidates whose mutation broke a template before spending
        # any rollouts; the feedback tells the reflection LM what to preserve.
        for phase, text in candidate.items():
            problem = validate_prompt_override(text)
            if problem:
                feedback = (
                    f'The proposed "{phase}" prompt template is invalid: {problem}. '
                    "The pipeline substitutes its serialized JSON input for the "
                    "{{INPUT_DATA}} placeholder, so the placeholder line must be kept verbatim."
                )
                outputs = [{"task": t.id, "invalid_candidate": feedback} for t in batch]
                return EvaluationBatch(
                    outputs=outputs,
                    scores=[0.0] * len(batch),
                    trajectories=outputs if capture_traces else None,
                    # No rollouts happened; without this, gepa falls back to
                    # len(batch) and malformed proposals eat the --budget.
                    num_metric_calls=0,
                )

        results = run_rollouts(batch, dict(candidate), self.cfg)
        outputs = [
            {
                "task": r.task.id,
                "score": r.score,
                "hidden_pass": r.hidden_pass,
                "judge_pass": None if r.pipeline is None else bool(r.pipeline.get("passed")),
                "rounds": None if r.pipeline is None else r.pipeline.get("rounds"),
                "feedback": r.feedback,
                "plan": None if r.pipeline is None else r.pipeline.get("plan"),
            }
            for r in results
        ]
        return EvaluationBatch(
            outputs=outputs,
            scores=[r.score for r in results],
            trajectories=outputs if capture_traces else None,
        )

    def make_reflective_dataset(
        self,
        candidate: dict[str, str],
        eval_batch: EvaluationBatch[RolloutResult, dict[str, Any]],
        components_to_update: list[str],
    ) -> dict[str, list[dict[str, Any]]]:
        dataset: dict[str, list[dict[str, Any]]] = {}
        for component in components_to_update:
            records = []
            for trace in eval_batch.trajectories or []:
                if "invalid_candidate" in trace:
                    records.append(
                        {
                            "Inputs": {"task": trace["task"]},
                            "Generated Outputs": "(not executed)",
                            "Feedback": trace["invalid_candidate"],
                        }
                    )
                    continue
                plan_excerpt = (trace.get("plan") or "")[:2000]
                if component == "plan":
                    generated = plan_excerpt or "(no plan captured)"
                else:
                    generated = (
                        f"judge_pass={trace['judge_pass']} rounds={trace['rounds']} "
                        f"hidden_check_pass={trace['hidden_pass']}"
                    )
                records.append(
                    {
                        "Inputs": {"task": trace["task"], "plan_excerpt": plan_excerpt if component != "plan" else None},
                        "Generated Outputs": generated,
                        "Feedback": trace["feedback"],
                    }
                )
            dataset[component] = records
        return dataset
