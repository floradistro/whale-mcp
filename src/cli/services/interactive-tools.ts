/**
 * Interactive Tools — user interaction during agent execution
 *
 * - AskUserQuestion: Multi-choice questions with optional custom input
 * - Plan Mode: Structured planning workflow with user approval
 */

import { EventEmitter } from "events";

// ============================================================================
// TYPES
// ============================================================================

export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface QuestionRequest {
  id: string;
  questions: Question[];
  resolve: (answers: Record<string, string | string[]>) => void;
  reject: (error: Error) => void;
}

export interface PlanModeState {
  active: boolean;
  planFile?: string;
  planContent?: string;
  startedAt?: Date;
}

// ============================================================================
// GLOBAL STATE
// ============================================================================

// Pending question requests (resolved by UI)
const pendingQuestions = new Map<string, QuestionRequest>();

// Plan mode state
let planModeState: PlanModeState = { active: false };

// Event emitter for UI coordination
export const interactiveEvents = new EventEmitter();

// ============================================================================
// ASK USER QUESTION
// ============================================================================

export function createQuestionRequest(questions: Question[]): QuestionRequest {
  const id = `question-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  return new Promise<Record<string, string | string[]>>((resolve, reject) => {
    const request: QuestionRequest = {
      id,
      questions,
      resolve,
      reject,
    };

    pendingQuestions.set(id, request);

    // Emit event for UI to pick up
    interactiveEvents.emit("question", request);
  }) as unknown as QuestionRequest;
}

export function getPendingQuestion(): QuestionRequest | undefined {
  // Return first pending question
  return pendingQuestions.values().next().value;
}

export function resolveQuestion(id: string, answers: Record<string, string | string[]>): boolean {
  const request = pendingQuestions.get(id);
  if (!request) return false;

  pendingQuestions.delete(id);
  request.resolve(answers);
  return true;
}

export function rejectQuestion(id: string, error: Error): boolean {
  const request = pendingQuestions.get(id);
  if (!request) return false;

  pendingQuestions.delete(id);
  request.reject(error);
  return true;
}

// ============================================================================
// PLAN MODE
// ============================================================================

export function enterPlanMode(planFile?: string): { success: boolean; message: string } {
  if (planModeState.active) {
    return {
      success: false,
      message: "Already in plan mode. Use ExitPlanMode to finish planning.",
    };
  }

  planModeState = {
    active: true,
    planFile: planFile || ".whale/plan.md",
    startedAt: new Date(),
  };

  interactiveEvents.emit("planModeEntered", planModeState);

  return {
    success: true,
    message: `Entered plan mode. Write your plan to ${planModeState.planFile}, then use ExitPlanMode when ready for approval.`,
  };
}

export function exitPlanMode(): { success: boolean; message: string } {
  if (!planModeState.active) {
    return {
      success: false,
      message: "Not in plan mode. Use EnterPlanMode first.",
    };
  }

  const planFile = planModeState.planFile;
  planModeState = { active: false };

  interactiveEvents.emit("planModeExited", { planFile });

  return {
    success: true,
    message: `Exited plan mode. Plan saved to ${planFile}. Ready for implementation.`,
  };
}

export function isPlanMode(): boolean {
  return planModeState.active;
}

export function getPlanModeState(): PlanModeState {
  return { ...planModeState };
}

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

export const INTERACTIVE_TOOL_DEFINITIONS = [
  {
    name: "ask_user_question",
    description: `Ask the user questions during execution. Use this to:
- Gather user preferences or requirements
- Clarify ambiguous instructions
- Get decisions on implementation choices
- Offer choices about direction

Users can always select "Other" to provide custom input.`,
    input_schema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "1-4 questions to ask the user",
          items: {
            type: "object",
            properties: {
              question: {
                type: "string",
                description: "The complete question to ask (ends with ?)",
              },
              header: {
                type: "string",
                description: "Short label (max 12 chars) like 'Auth method' or 'Library'",
              },
              options: {
                type: "array",
                description: "2-4 choices (Other is added automatically)",
                items: {
                  type: "object",
                  properties: {
                    label: {
                      type: "string",
                      description: "Concise choice text (1-5 words)",
                    },
                    description: {
                      type: "string",
                      description: "Explanation of what this choice means",
                    },
                  },
                  required: ["label", "description"],
                },
              },
              multiSelect: {
                type: "boolean",
                description: "Allow selecting multiple options (default: false)",
              },
            },
            required: ["question", "header", "options"],
          },
        },
      },
      required: ["questions"],
    },
  },
  {
    name: "enter_plan_mode",
    description: `Enter plan mode for complex tasks requiring careful planning before implementation.

Use this when:
- Multiple valid approaches exist with trade-offs
- Significant architectural decisions are needed
- Large-scale changes touch many files
- Requirements are unclear and need exploration
- You need to ask clarifying questions before starting

In plan mode, you explore the codebase and design an approach, then present it for user approval before implementing.`,
    input_schema: {
      type: "object",
      properties: {
        plan_file: {
          type: "string",
          description: "File to write the plan to (default: .whale/plan.md)",
        },
      },
      required: [],
    },
  },
  {
    name: "exit_plan_mode",
    description: `Exit plan mode after writing your plan. The user will review and approve the plan before implementation begins.

Only use this after you have:
1. Thoroughly explored the codebase
2. Written a clear plan to the plan file
3. Resolved any ambiguities with the user`,
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

// ============================================================================
// EXECUTE INTERACTIVE TOOLS
// ============================================================================

export async function executeInteractiveTool(
  name: string,
  input: Record<string, unknown>
): Promise<{ success: boolean; output: string; pendingQuestion?: QuestionRequest }> {
  switch (name) {
    case "ask_user_question": {
      const questions = input.questions as Question[];
      if (!Array.isArray(questions) || questions.length === 0) {
        return { success: false, output: "questions array is required" };
      }
      if (questions.length > 4) {
        return { success: false, output: "Maximum 4 questions allowed" };
      }

      // Create the request — UI will handle it
      const id = `question-${Date.now()}`;
      const request: QuestionRequest = {
        id,
        questions: questions.map((q) => ({
          question: q.question,
          header: q.header?.slice(0, 12) || "Question",
          options: (q.options || []).slice(0, 4).map((o) => ({
            label: o.label,
            description: o.description || "",
          })),
          multiSelect: q.multiSelect || false,
        })),
        resolve: () => {},
        reject: () => {},
      };

      // Store for UI to pick up
      pendingQuestions.set(id, request);
      interactiveEvents.emit("question", request);

      return {
        success: true,
        output: `Question pending: ${questions[0].question}`,
        pendingQuestion: request,
      };
    }

    case "enter_plan_mode": {
      const result = enterPlanMode(input.plan_file as string);
      return { success: result.success, output: result.message };
    }

    case "exit_plan_mode": {
      const result = exitPlanMode();
      return { success: result.success, output: result.message };
    }

    default:
      return { success: false, output: `Unknown interactive tool: ${name}` };
  }
}
