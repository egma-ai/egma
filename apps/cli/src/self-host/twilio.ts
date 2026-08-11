/**
 * Twilio, as a carrier a platform routes through — read first, then written.
 *
 * A phone call leaves the simulator through a **SIP trunk**, and a trunk is the
 * platform's own: a self-hoster brings an account from whatever carrier they
 * already pay, and egma is never in that relationship. What they have on day
 * one is an account and a number they already own. What the simulator reads is
 * a termination address and a credential that may place calls through it.
 * Everything between those two is carrier paperwork, and this is the module
 * that does it — through Twilio's own API.
 *
 * ## It never buys a number
 *
 * There is no code here that searches the catalogue, buys, ports or registers
 * anything, and that is a promise about spending somebody else's money rather
 * than a feature that has not been written yet. A number setup is pointed at
 * must already be on the account, and setup says so and stops when it is not —
 * before it has created anything at all.
 *
 * ## Plan, then apply
 *
 * `plan` reads the account and answers what it would do. It writes nothing,
 * anywhere, and everything in its answer is non-secret. `apply` does it.
 *
 * ## What it makes, in Twilio's words
 *
 * 1. An **Elastic SIP Trunk**, whose `DomainName` is the termination URI calls
 *    are sent to (`egma-….pstn.twilio.com`). Domain names are unique across the
 *    whole of Twilio, not just one account, so a minted name can collide with a
 *    stranger's and setup tries another.
 * 2. A **credential list** holding one username and password. This is the
 *    least-privileged credential the deployment keeps.
 * 3. The credential list **attached** to the trunk — without which the trunk
 *    authenticates nobody and every call is a 403.
 * 4. The **number attached** to the trunk, which is what makes it a caller id
 *    the carrier will accept on an outbound call.
 *
 * Every one of the four is found and reused when it is already there, which is
 * what makes a retry after a half-finished setup safe: it finishes the half
 * that is missing and creates no second copy of the half that is not.
 *
 * ## No origination URI, deliberately
 *
 * A trunk has two directions and setup configures one. egma dials *out*; the
 * persona is never called. Configuring origination would tell Twilio where to
 * send calls arriving *at* the number, which for this deployment is nowhere,
 * and would put a laptop's SIP gateway on the public internet as a destination.
 * A trunk with no origination URI is a correctly configured outbound trunk.
 *
 * ## The Auth Token is used here and nowhere else
 *
 * It opens the whole account — every number, every recording, every log, the
 * billing — and a running simulator has no business holding it. What setup
 * leaves behind is a SIP credential that can do one thing: authenticate a call
 * over one trunk. That is the entire reason the account credentials are a
 * setup-time input rather than nine more variables on a container.
 */

/** What setup calls everything it makes on the account. */
export const ARTIFACT_NAME = "egma-simulator";

export const TWILIO_API_ROOT = "https://api.twilio.com";
export const TWILIO_TRUNKING_ROOT = "https://trunking.twilio.com";

/** What every Twilio termination URI ends in; the part before it is ours. */
const TERMINATION_SUFFIX = ".pstn.twilio.com";

/**
 * How long the minted SIP password is. Twilio's own floor is twelve with an
 * uppercase, a lowercase and a digit; this is twice that and alphanumeric
 * throughout, so it survives being written into an env file, a URL and a SIP
 * header without anything having to escape it.
 */
const PASSWORD_LENGTH = 24;

/**
 * How many times a taken domain name is tried around. Each try is 8 random hex
 * characters, so a fifth failure is not bad luck.
 */
const DOMAIN_ATTEMPTS = 5;

/**
 * Twilio's code for a termination URI somebody already holds.
 *
 * Matched as the number rather than by its sentence: the sentence is theirs to
 * reword in a release note, and a rewording would turn "try another name" into
 * an unexplained failure at the one step that has to survive it.
 */
const DOMAIN_TAKEN = 21241;

/** How many of anything to ask for at once. Twilio's own default page is 50. */
const PAGE_SIZE = 100;

const REQUEST_TIMEOUT_MS = 30_000;

export class CarrierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CarrierError";
  }
}

export type TwilioAccess = {
  readonly accountSid: string;
  readonly authToken: string;
  readonly apiRoot?: string;
  readonly trunkingRoot?: string;
};

/** One thing setup would do, or did, said without a secret in it. */
export type CarrierStep = {
  /** What it is, in the vocabulary a Twilio console uses. */
  readonly what:
    | "trunk"
    | "credential-list"
    | "sip-credential"
    | "credential-list-on-trunk"
    | "number-on-trunk";
  /** `reuse` when it is already there and correct, `create` when it is not. */
  readonly action: "reuse" | "create" | "rotate";
  /** The identifier, once there is one. Non-secret; Twilio SIDs always are. */
  readonly sid: string | null;
  /** One sentence a person reads. Never carries a secret. */
  readonly detail: string;
};

export type CarrierPlan = {
  readonly accountSid: string;
  readonly sourceNumber: string;
  readonly sourceNumberSid: string;
  readonly trunkName: string;
  readonly trunkSid: string | null;
  readonly trunkAddress: string | null;
  readonly steps: readonly CarrierStep[];
};

export type CarrierResult = {
  readonly trunkSid: string;
  readonly trunkAddress: string;
  readonly sourceNumber: string;
  readonly sipUsername: string;
  /** Minted here, known only here, and never printed. */
  readonly sipPassword: string;
  readonly steps: readonly CarrierStep[];
};

type Json = Record<string, unknown>;

class TwilioAccount {
  readonly #headers: Record<string, string>;
  readonly #sid: string;
  readonly #api: string;
  readonly #trunking: string;

  constructor(access: TwilioAccess) {
    this.#sid = access.accountSid;
    this.#api = (access.apiRoot ?? TWILIO_API_ROOT).replace(/\/$/, "");
    this.#trunking = (access.trunkingRoot ?? TWILIO_TRUNKING_ROOT).replace(/\/$/, "");
    const encoded = Buffer.from(
      `${access.accountSid}:${access.authToken}`,
      "utf8",
    ).toString("base64");
    this.#headers = { authorization: `Basic ${encoded}` };
  }

  #accountPath(tail: string): string {
    return `${this.#api}/2010-04-01/Accounts/${this.#sid}/${tail}`;
  }

  async #call(
    method: "GET" | "POST",
    url: string,
    { body, allow = [] }: { body?: Record<string, string>; allow?: readonly number[] } = {},
  ): Promise<{ status: number; body: Json }> {
    let answer: Response;
    try {
      answer = await fetch(url, {
        method,
        headers:
          body === undefined
            ? this.#headers
            : {
                ...this.#headers,
                "content-type": "application/x-www-form-urlencoded",
              },
        ...(body === undefined
          ? {}
          : { body: new URLSearchParams(body).toString() }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (unreachable) {
      // The Auth Token is on the request, so anything that rendered the
      // request would carry it. Only the URL and the kind of failure are
      // repeated back.
      throw new CarrierError(
        `twilio could not be reached at ${url}: ${
          unreachable instanceof Error ? unreachable.name : "unknown failure"
        }`,
      );
    }
    const text = await answer.text();
    let parsed: Json = {};
    try {
      parsed = text === "" ? {} : (JSON.parse(text) as Json);
    } catch {
      parsed = {};
    }
    if (answer.status >= 400 && !allow.includes(answer.status)) {
      throw new CarrierError(refusal(answer.status, parsed));
    }
    return { status: answer.status, body: parsed };
  }

  /**
   * Everything under one key, across as many pages as Twilio hands back.
   *
   * Both of Twilio's APIs page, and they say so differently — the trunking one
   * puts the next page under `meta`, the older one puts a path in
   * `next_page_uri`. Reading only the first page is the bug that does not look
   * like one: on a busy account the trunk setup made last week is on page two,
   * so it makes another.
   */
  async #every(url: string, key: string, params: Record<string, string> = {}): Promise<Json[]> {
    const gathered: Json[] = [];
    let following: string | null = withQuery(url, { ...params, PageSize: String(PAGE_SIZE) });
    while (following !== null) {
      const { body } = await this.#call("GET", following);
      const page = body[key];
      if (Array.isArray(page)) gathered.push(...(page as Json[]));
      following = this.#nextPage(body);
    }
    return gathered;
  }

  #nextPage(body: Json): string | null {
    const meta = body["meta"];
    const onward =
      typeof meta === "object" && meta !== null
        ? (meta as Json)["next_page_url"]
        : undefined;
    if (typeof onward === "string" && onward !== "") return onward;
    const older = body["next_page_uri"];
    // The older API answers with a path rather than a URL.
    return typeof older === "string" && older !== "" ? `${this.#api}${older}` : null;
  }

  /**
   * The account's own number, by its E.164 form.
   *
   * Read before anything is created, always: a number this account does not
   * hold cannot be attached to any trunk, and finding that out after making
   * three things leaves a stranger's account holding three things they did not
   * ask for.
   */
  async numberSid(number: string): Promise<string> {
    const held = await this.#every(
      this.#accountPath("IncomingPhoneNumbers.json"),
      "incoming_phone_numbers",
      { PhoneNumber: number },
    );
    for (const one of held) {
      if (one["phone_number"] === number) return String(one["sid"]);
    }
    throw new CarrierError(
      `this Twilio account holds no number ${number}. It has to be one this ` +
        "account already owns, in E.164 (+15551234567), because a carrier will " +
        "not place a call from a number somebody else holds — and egma never " +
        "buys, ports or registers one on your behalf. Buy the number in the " +
        "Twilio console and run this again.",
    );
  }

  /** The trunk setup made before, or `null`. Reads only. */
  async findTrunk(name: string): Promise<Json | null> {
    for (const trunk of await this.#every(`${this.#trunking}/v1/Trunks`, "trunks")) {
      if (trunk["friendly_name"] === name) return trunk;
    }
    return null;
  }

  async createTrunk(name: string): Promise<Json> {
    const refusals: string[] = [];
    for (let attempt = 0; attempt < DOMAIN_ATTEMPTS; attempt += 1) {
      const domain = `${name}-${randomHex(4)}${TERMINATION_SUFFIX}`;
      const { status, body } = await this.#call("POST", `${this.#trunking}/v1/Trunks`, {
        body: { FriendlyName: name, DomainName: domain },
        allow: [400],
      });
      if (status < 400) return body;
      if (body["code"] !== DOMAIN_TAKEN) throw new CarrierError(refusal(status, body));
      refusals.push(String(body["message"] ?? ""));
    }
    throw new CarrierError(
      `no termination URI could be claimed in ${DOMAIN_ATTEMPTS} tries — twilio ` +
        `said: ${refusals[refusals.length - 1] ?? ""}`,
    );
  }

  async findCredentialList(name: string): Promise<Json | null> {
    const held = await this.#every(
      this.#accountPath("SIP/CredentialLists.json"),
      "credential_lists",
    );
    for (const list of held) if (list["friendly_name"] === name) return list;
    return null;
  }

  async createCredentialList(name: string): Promise<Json> {
    const { body } = await this.#call("POST", this.#accountPath("SIP/CredentialLists.json"), {
      body: { FriendlyName: name },
    });
    return body;
  }

  async findCredential(listSid: string, username: string): Promise<Json | null> {
    const held = await this.#every(
      this.#accountPath(`SIP/CredentialLists/${listSid}/Credentials.json`),
      "credentials",
    );
    for (const one of held) if (one["username"] === username) return one;
    return null;
  }

  /**
   * This username's password, set or replaced.
   *
   * Rotating rather than reading is not a choice: Twilio hands a password back
   * exactly once, when it is set, and never again. A second run that wanted to
   * keep the old one would have to have stored it somewhere, and the only place
   * to store it is the file setup is writing.
   */
  async setPassword(listSid: string, username: string, password: string): Promise<string> {
    const held = await this.findCredential(listSid, username);
    if (held !== null) {
      await this.#call(
        "POST",
        this.#accountPath(`SIP/CredentialLists/${listSid}/Credentials/${String(held["sid"])}.json`),
        { body: { Password: password } },
      );
      return String(held["sid"]);
    }
    const { body } = await this.#call(
      "POST",
      this.#accountPath(`SIP/CredentialLists/${listSid}/Credentials.json`),
      { body: { Username: username, Password: password } },
    );
    return String(body["sid"]);
  }

  async credentialListsOn(trunkSid: string): Promise<Json[]> {
    return this.#every(`${this.#trunking}/v1/Trunks/${trunkSid}/CredentialLists`, "credential_lists");
  }

  async attachCredentialList(trunkSid: string, listSid: string): Promise<void> {
    await this.#call("POST", `${this.#trunking}/v1/Trunks/${trunkSid}/CredentialLists`, {
      body: { CredentialListSid: listSid },
    });
  }

  async numbersOn(trunkSid: string): Promise<Json[]> {
    return this.#every(`${this.#trunking}/v1/Trunks/${trunkSid}/PhoneNumbers`, "phone_numbers");
  }

  async attachNumber(trunkSid: string, numberSid: string): Promise<void> {
    await this.#call("POST", `${this.#trunking}/v1/Trunks/${trunkSid}/PhoneNumbers`, {
      body: { PhoneNumberSid: numberSid },
    });
  }
}

/**
 * What setup would do to this account, having read it. Changes nothing.
 *
 * Every field of the answer is non-secret: Twilio SIDs, a termination hostname,
 * a number the account already owns and already publishes as caller id. There
 * is nothing in a plan that could not be printed on a wall, which is what makes
 * showing one before approval worth doing.
 */
export async function planCarrier(
  access: TwilioAccess,
  { number, name = ARTIFACT_NAME }: { number: string; name?: string },
): Promise<CarrierPlan> {
  const account = new TwilioAccount(access);
  const sourceNumberSid = await account.numberSid(number);
  const trunk = await account.findTrunk(name);
  const credentialList = await account.findCredentialList(name);

  const steps: CarrierStep[] = [];
  const trunkSid = trunk === null ? null : String(trunk["sid"]);
  const trunkAddress = trunk === null ? null : String(trunk["domain_name"]);

  steps.push(
    trunk === null
      ? {
          what: "trunk",
          action: "create",
          sid: null,
          detail: `create an elastic SIP trunk named ${name}, with a fresh ${TERMINATION_SUFFIX} termination URI`,
        }
      : {
          what: "trunk",
          action: "reuse",
          sid: trunkSid,
          detail: `reuse the existing trunk ${name} (${trunkSid}), termination URI ${trunkAddress}`,
        },
  );

  const listSid = credentialList === null ? null : String(credentialList["sid"]);
  steps.push(
    credentialList === null
      ? {
          what: "credential-list",
          action: "create",
          sid: null,
          detail: `create a credential list named ${name}`,
        }
      : {
          what: "credential-list",
          action: "reuse",
          sid: listSid,
          detail: `reuse the existing credential list ${name} (${listSid})`,
        },
  );

  const existingCredential =
    listSid === null ? null : await account.findCredential(listSid, name);
  steps.push({
    what: "sip-credential",
    action: existingCredential === null ? "create" : "rotate",
    sid: existingCredential === null ? null : String(existingCredential["sid"]),
    detail:
      existingCredential === null
        ? `create a SIP credential for ${name} with a password egma mints`
        : `set a new password on the existing SIP credential for ${name} — twilio ` +
          "shows a password once and never again, so a re-run has to mint another",
  });

  const attachedLists = trunkSid === null ? [] : await account.credentialListsOn(trunkSid);
  const alreadyAttached =
    listSid !== null && attachedLists.some((one) => one["sid"] === listSid);
  steps.push({
    what: "credential-list-on-trunk",
    action: alreadyAttached ? "reuse" : "create",
    sid: alreadyAttached ? listSid : null,
    detail: alreadyAttached
      ? "the credential list is already on the trunk"
      : "attach the credential list to the trunk, without which every call is a 403",
  });

  const attachedNumbers = trunkSid === null ? [] : await account.numbersOn(trunkSid);
  const numberAttached = attachedNumbers.some((one) => one["sid"] === sourceNumberSid);
  steps.push({
    what: "number-on-trunk",
    action: numberAttached ? "reuse" : "create",
    sid: numberAttached ? sourceNumberSid : null,
    detail: numberAttached
      ? `${number} (${sourceNumberSid}) is already on the trunk`
      : `attach ${number} (${sourceNumberSid}), which this account already owns, to the trunk`,
  });

  return {
    accountSid: access.accountSid,
    sourceNumber: number,
    sourceNumberSid,
    trunkName: name,
    trunkSid,
    trunkAddress,
    steps,
  };
}

/**
 * Do it. Safe to run again, and safe to run after a run that stopped half way.
 *
 * Every step reads before it writes, so a second run finds four things standing
 * and makes the fifth. The password turns last, once everything else stands:
 * rotation replaces a credential a running deployment may be dialling with, and
 * a failure after the rotation but before the configuration was written would
 * leave that deployment refusing 403 on a password nobody holds any more.
 */
export async function applyCarrier(
  access: TwilioAccess,
  { number, name = ARTIFACT_NAME }: { number: string; name?: string },
): Promise<CarrierResult> {
  const account = new TwilioAccount(access);
  const steps: CarrierStep[] = [];

  const sourceNumberSid = await account.numberSid(number);

  let trunk = await account.findTrunk(name);
  if (trunk === null) {
    trunk = await account.createTrunk(name);
    steps.push({
      what: "trunk",
      action: "create",
      sid: String(trunk["sid"]),
      detail: `created trunk ${String(trunk["sid"])}, termination URI ${String(trunk["domain_name"])}`,
    });
  } else {
    steps.push({
      what: "trunk",
      action: "reuse",
      sid: String(trunk["sid"]),
      detail: `reused trunk ${String(trunk["sid"])}, termination URI ${String(trunk["domain_name"])}`,
    });
  }
  const trunkSid = String(trunk["sid"]);
  const trunkAddress = String(trunk["domain_name"]);

  let credentialList = await account.findCredentialList(name);
  if (credentialList === null) {
    credentialList = await account.createCredentialList(name);
    steps.push({
      what: "credential-list",
      action: "create",
      sid: String(credentialList["sid"]),
      detail: `created credential list ${String(credentialList["sid"])}`,
    });
  } else {
    steps.push({
      what: "credential-list",
      action: "reuse",
      sid: String(credentialList["sid"]),
      detail: `reused credential list ${String(credentialList["sid"])}`,
    });
  }
  const listSid = String(credentialList["sid"]);

  const attachedLists = await account.credentialListsOn(trunkSid);
  if (attachedLists.some((one) => one["sid"] === listSid)) {
    steps.push({
      what: "credential-list-on-trunk",
      action: "reuse",
      sid: listSid,
      detail: "the credential list was already on the trunk",
    });
  } else {
    await account.attachCredentialList(trunkSid, listSid);
    steps.push({
      what: "credential-list-on-trunk",
      action: "create",
      sid: listSid,
      detail: "attached the credential list to the trunk",
    });
  }

  const attachedNumbers = await account.numbersOn(trunkSid);
  if (attachedNumbers.some((one) => one["sid"] === sourceNumberSid)) {
    steps.push({
      what: "number-on-trunk",
      action: "reuse",
      sid: sourceNumberSid,
      detail: `${number} (${sourceNumberSid}) was already on the trunk`,
    });
  } else {
    await account.attachNumber(trunkSid, sourceNumberSid);
    steps.push({
      what: "number-on-trunk",
      action: "create",
      sid: sourceNumberSid,
      detail: `attached ${number} (${sourceNumberSid}) to the trunk`,
    });
  }

  const existing = await account.findCredential(listSid, name);
  const sipPassword = mintPassword();
  const credentialSid = await account.setPassword(listSid, name, sipPassword);
  steps.push({
    what: "sip-credential",
    action: existing === null ? "create" : "rotate",
    sid: credentialSid,
    detail:
      existing === null
        ? `created the SIP credential ${credentialSid} for ${name}`
        : `set a new password on the SIP credential ${credentialSid} for ${name}`,
  });

  return {
    trunkSid,
    trunkAddress,
    sourceNumber: number,
    sipUsername: name,
    sipPassword,
    steps,
  };
}

/**
 * Twilio's own refusal, in Twilio's own words.
 *
 * Their message is the diagnosis — "not available on trial accounts",
 * "DomainName is already in use", "Authenticate" — and summarising it would
 * throw away the only thing that says what to do next. 401 is the one place a
 * name is added: what it means is one input, and saying so saves a search.
 */
function refusal(status: number, body: Json): string {
  const said = String(body["message"] ?? JSON.stringify(body)) || "no reason given";
  if (status === 401) {
    return (
      "twilio refused the account credentials (401): check the Account SID and " +
      `the Auth Token — twilio said: ${said}`
    );
  }
  return `twilio refused with ${status}: ${said}`;
}

function withQuery(url: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return query === "" ? url : `${url}${url.includes("?") ? "&" : "?"}${query}`;
}

function randomHex(bytes: number): string {
  const drawn = new Uint8Array(bytes);
  crypto.getRandomValues(drawn);
  return Array.from(drawn, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A password Twilio will accept, minted here and known only here.
 *
 * Built from the three character classes it insists on and then shuffled, so
 * the rule is satisfied by construction rather than by drawing until it happens
 * to be — which on a bad draw is a loop and on a worse one is a refusal at the
 * end of a setup that already made three things.
 */
function mintPassword(): string {
  const lower = "abcdefghijklmnopqrstuvwxyz";
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const digits = "0123456789";
  const alphabet = lower + upper + digits;
  const drawn = [pick(lower), pick(upper), pick(digits)];
  while (drawn.length < PASSWORD_LENGTH) drawn.push(pick(alphabet));
  for (let index = drawn.length - 1; index > 0; index -= 1) {
    // The ordering carries as much of the entropy as the characters do, so the
    // shuffle draws from the same source rather than from Math.random.
    const swap = randomBelow(index + 1);
    [drawn[index], drawn[swap]] = [drawn[swap] as string, drawn[index] as string];
  }
  return drawn.join("");
}

function pick(from: string): string {
  return from[randomBelow(from.length)] as string;
}

function randomBelow(bound: number): number {
  const drawn = new Uint32Array(1);
  crypto.getRandomValues(drawn);
  return (drawn[0] as number) % bound;
}
