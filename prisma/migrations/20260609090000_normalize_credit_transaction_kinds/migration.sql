UPDATE "CreditTransaction"
SET "kind" = CASE
  WHEN "kind" = 'REFUND' THEN 'refund'
  WHEN "kind" = 'DEBIT' AND COALESCE("metadata"->>'intent', '') IN ('bulk_generate') THEN 'bulk_generation'
  WHEN "kind" = 'DEBIT' AND COALESCE("metadata"->>'intent', '') IN ('jobs_retry', 'bulk_retry', 'retry_one') THEN 'regeneration'
  WHEN "kind" = 'DEBIT' THEN 'generation'
  ELSE "kind"
END
WHERE "kind" IN ('DEBIT', 'REFUND');
