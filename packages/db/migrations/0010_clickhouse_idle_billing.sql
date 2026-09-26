ALTER TABLE public.cloud_billing_account
  ADD COLUMN inference_usage_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN inference_settled_version bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT cloud_billing_account_inference_versions_are_exact
    CHECK (inference_settled_version >= 0
      AND inference_settled_version <= inference_usage_version
      AND inference_usage_version <= 9007199254740991);

-- Existing accounts receive one cumulative reconciliation after deployment.
UPDATE public.cloud_billing_account SET inference_usage_version = 1;
