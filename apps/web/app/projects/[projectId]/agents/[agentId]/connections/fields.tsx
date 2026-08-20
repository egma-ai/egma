"use client";

import type { ReactNode } from "react";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, Help } from "../../../../../../ui/form.tsx";
import type {
  ConnectionOption,
  ConfigField,
  CredentialField,
} from "../../../../../../lib/connection-options.ts";

/**
 * The fields one connection shape asks for, drawn from what the server said
 * they are.
 *
 * **Nothing here knows what a Retell agent id or a LiveKit URL is.** The server
 * sends a key, a label, a kind, whether it is required and a sentence of help,
 * and this draws a control for it. That is what keeps the form and the gate in
 * step: a shape that gains a key gains a box with nothing edited here, and a
 * shape that loses one loses its box the same way.
 *
 * `kind` decides the control and nothing else. The gate on the server is still
 * the only thing that admits a value, so a form that drew a plain box for a URL
 * cannot get a bad URL past anything — which is why a `json` field is a text
 * area rather than a validating editor, and why an `e164` field says what the
 * shape looks like rather than trying to enforce it.
 */

export type Draft = {
  readonly config: Readonly<Record<string, string>>;
  readonly credentials: Readonly<Record<string, string>>;
};

function ConfigControl({
  field,
  value,
  onChange,
}: {
  readonly field: ConfigField;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const id = `config-${field.key}`;
  const helpId = `${id}-help`;

  return (
    <Field
      label={field.required ? field.label : `${field.label} (optional)`}
      htmlFor={id}
    >
      {field.kind === "json" ? (
        <Textarea
          id={id}
          value={value}
          rows={3}
          aria-describedby={helpId}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Input
          id={id}
          value={value}
          aria-describedby={helpId}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      <Help id={helpId}>{field.help}</Help>
    </Field>
  );
}

function CredentialControl({
  field,
  value,
  onChange,
}: {
  readonly field: CredentialField;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const id = `credential-${field.field}`;
  const helpId = `${id}-help`;

  return (
    <Field label={field.label} htmlFor={id}>
      {field.kind === "json" ? (
        // A set of headers is secret in its values and ordinary in its names,
        // and it is too long for one line — so it gets room rather than a
        // password box that would hide what somebody is trying to paste.
        <Textarea
          id={id}
          value={value}
          rows={3}
          aria-describedby={helpId}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Input
          id={id}
          value={value}
          type="password"
          autoComplete="new-password"
          aria-describedby={helpId}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      <Help id={helpId}>{field.help}</Help>
    </Field>
  );
}

export function ConnectionFields({
  option,
  draft,
  onChange,
  credentialsEditable,
  beforeCredentialFields,
}: {
  readonly option: ConnectionOption;
  readonly draft: Draft;
  readonly onChange: (draft: Draft) => void;
  /**
   * Whether the credential boxes are shown at all.
   *
   * An edit hides them until somebody asks to rotate, because a credential
   * replaces whole or stays untouched — there is no merge, since a merge would
   * mean reading the stored secret back out to edit it, and egma will not
   * answer with one. Boxes standing empty on an edit form would read as "this
   * connection has no credential", which for most shapes is false.
   */
  readonly credentialsEditable: boolean;
  /** Provider-specific setup that belongs after target fields and before secrets. */
  readonly beforeCredentialFields?: ReactNode;
}) {
  const setConfig = (key: string, value: string) =>
    onChange({ ...draft, config: { ...draft.config, [key]: value } });
  const setCredential = (field: string, value: string) =>
    onChange({ ...draft, credentials: { ...draft.credentials, [field]: value } });
  const targetFields = option.fields.filter(
    (field) => field.after_credentials !== true,
  );
  const afterCredentials = option.fields.filter(
    (field) => field.after_credentials === true,
  );

  return (
    <>
      {targetFields.map((field) => (
        <ConfigControl
          key={field.key}
          field={field}
          value={draft.config[field.key] ?? ""}
          onChange={(value) => setConfig(field.key, value)}
        />
      ))}

      {beforeCredentialFields}

      {credentialsEditable && option.credential_rule !== "forbidden" ? (
        <>
          <Help>{option.credential_help}</Help>
          {option.credential_fields.map((field) => (
            <CredentialControl
              key={field.field}
              field={field}
              value={draft.credentials[field.field] ?? ""}
              onChange={(value) => setCredential(field.field, value)}
            />
          ))}
        </>
      ) : null}

      {afterCredentials.map((field) => (
        <ConfigControl
          key={field.key}
          field={field}
          value={draft.config[field.key] ?? ""}
          onChange={(value) => setConfig(field.key, value)}
        />
      ))}
    </>
  );
}
