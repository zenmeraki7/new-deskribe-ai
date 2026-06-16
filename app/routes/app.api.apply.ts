import { json, type ActionFunctionArgs } from "@remix-run/node";

import { ApplyNotReadyError, ApplyPreconditionError, enqueueApplyJob } from "../lib/apply.server";
import {
  isServerValidationError,
  validateEnqueueApplyJob,
  validationErrorResponse,
} from "../server/validation/serverLimits";
import { adminActorLabel, requireAdminSession } from "../lib/auth.server";

export async function action({ request }: ActionFunctionArgs) {
  const authContext = await requireAdminSession(request);
  const { shopDomain } = authContext;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json(
      { ok: false, error: "Apply requests must be JSON." },
      { status: 400 },
    );
  }

  try {
    const parsed = validateEnqueueApplyJob(raw);
    const result = await enqueueApplyJob({
      shopDomain,
      jobId: parsed.jobId,
      applyId: parsed.applyId,
      productIds: parsed.productIds,
      requestedBy: adminActorLabel(authContext),
    });

    return json({ ok: true, applyId: result.applyId });
  } catch (error) {
    if (isServerValidationError(error)) {
      return validationErrorResponse(error);
    }

    if (error instanceof ApplyNotReadyError) {
      return json(
        { ok: false, error: error.message, code: error.code },
        { status: error.status },
      );
    }

    if (error instanceof ApplyPreconditionError) {
      return json(
        { ok: false, error: error.message, code: error.code },
        { status: error.status },
      );
    }

    return json(
      { ok: false, error: "Apply job could not be queued." },
      { status: 500 },
    );
  }
}
