export type Agent = {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly description: string | null;
};

export type Connection = {
  readonly id: string;
  readonly agentId: string;
  readonly projectId: string;
  readonly name: string;
  readonly type: string;
  readonly modality: string;
  readonly config: Readonly<Record<string, string>>;
  readonly credentialsHint: string | null;
};

export type CreatedAgent = Agent & {
  readonly connection?: Connection;
};

export type TestPersona = {
  readonly id: string;
  readonly name: string;
  readonly deletedAt: string | null;
};

export type Persona = {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
};

export type Test = {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly description: string | null;
  readonly version: number;
  readonly versionId: string;
  readonly scenario: string;
  readonly expectedBehaviors: readonly string[];
  readonly personas: readonly TestPersona[];
};

export type Page<T> = {
  readonly items: readonly T[];
  readonly nextCursor?: string;
};

export type ResourceAction = "created" | "reused";
