CREATE TABLE public.simulation_grading_handoff (
  simulation_id text COLLATE "C" PRIMARY KEY,
  organization_id text COLLATE "C" NOT NULL,
  project_id text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT simulation_grading_handoff_id_prefix
    CHECK (simulation_id ~ '^sim_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT simulation_grading_handoff_project_organization_fk
    FOREIGN KEY (project_id, organization_id)
    REFERENCES public.project (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT simulation_grading_handoff_simulation_project_fk
    FOREIGN KEY (simulation_id, project_id)
    REFERENCES public.simulation (id, project_id) ON DELETE CASCADE
);

INSERT INTO public.simulation_grading_handoff (simulation_id, organization_id, project_id)
SELECT simulation_id, organization_id, project_id
FROM public.grading_job
WHERE source = 'simulation';
