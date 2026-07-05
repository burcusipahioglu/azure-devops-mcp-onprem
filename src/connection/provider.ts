import * as azdev from "azure-devops-node-api";
import type { Config } from "../config.js";
import type {
  WorkItemContext,
  GitContext,
  TfvcContext,
  BuildContext,
  ReleaseContext,
  TestContext,
  TestPlanContext,
  WikiContext,
} from "./context-types.js";

export interface UserIdentity {
  displayName: string;
  id: string;
  uniqueName: string;
}

export interface IConnectionProvider {
  getWorkItemContext(): Promise<WorkItemContext>;
  getGitContext(): Promise<GitContext>;
  getTfvcContext(): Promise<TfvcContext>;
  getBuildContext(): Promise<BuildContext>;
  getReleaseContext(): Promise<ReleaseContext>;
  getTestContext(): Promise<TestContext>;
  getTestPlanContext(): Promise<TestPlanContext>;
  getWikiContext(): Promise<WikiContext>;
  resolveCurrentUser(): Promise<UserIdentity>;
  resolveIdentityId(query: string): Promise<string | undefined>;
}

export class AzureDevOpsConnectionProvider implements IConnectionProvider {
  private connection: azdev.WebApi | null = null;
  private cachedUser: UserIdentity | null = null;

  constructor(private config: Config) {}

  private getConnection(): azdev.WebApi {
    if (this.connection) return this.connection;

    const authHandler = azdev.getPersonalAccessTokenHandler(this.config.pat);
    this.connection = new azdev.WebApi(this.config.orgUrl, authHandler, {
      ignoreSslError: this.config.sslIgnore,
    });

    return this.connection;
  }

  async getWorkItemContext(): Promise<WorkItemContext> {
    return {
      api: await this.getConnection().getWorkItemTrackingApi(),
      project: this.config.project,
      orgUrl: this.config.orgUrl,
    };
  }

  async getGitContext(): Promise<GitContext> {
    return {
      api: await this.getConnection().getGitApi(),
      project: this.config.project,
    };
  }

  async getTfvcContext(): Promise<TfvcContext> {
    return {
      api: await this.getConnection().getTfvcApi(),
      project: this.config.project,
    };
  }

  async getBuildContext(): Promise<BuildContext> {
    return {
      api: await this.getConnection().getBuildApi(),
      project: this.config.project,
    };
  }

  async getReleaseContext(): Promise<ReleaseContext> {
    return {
      api: await this.getConnection().getReleaseApi(),
      project: this.config.project,
    };
  }

  async getTestContext(): Promise<TestContext> {
    return {
      api: await this.getConnection().getTestApi(),
      project: this.config.project,
    };
  }

  async getTestPlanContext(): Promise<TestPlanContext> {
    return {
      api: await this.getConnection().getTestPlanApi(),
      project: this.config.project,
    };
  }

  async getWikiContext(): Promise<WikiContext> {
    return {
      api: await this.getConnection().getWikiApi(),
      project: this.config.project,
    };
  }

  async resolveCurrentUser(): Promise<UserIdentity> {
    if (this.cachedUser) return this.cachedUser;

    const conn = this.getConnection();
    const connData = await conn.connect();
    const user = connData.authenticatedUser;

    this.cachedUser = {
      displayName: user?.providerDisplayName || user?.customDisplayName || "Unknown",
      id: user?.id || "",
      uniqueName: (user as Record<string, unknown>)?.uniqueName as string || "",
    };

    return this.cachedUser;
  }

  // Resolve a display name / sign-in email / UPN to an Azure DevOps identity
  // GUID via the collection-level Identities endpoint. A GUID-shaped input is
  // trusted as-is (see below). Returns undefined when a name matches nothing;
  // throws when a name is ambiguous, or when the identities endpoint is not
  // reachable with this PAT's scope.
  async resolveIdentityId(query: string): Promise<string | undefined> {
    const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const trimmed = query.trim();

    // A GUID-shaped input passes through untouched. We deliberately do NOT
    // verify it against the identities endpoint: on on-prem collections whose
    // PAT lacks the Identity (Read) scope that endpoint returns 401, and a
    // verification step would break the one reviewer path (a raw identity GUID)
    // that works without that scope. Trusting the GUID keeps that path alive.
    if (GUID.test(trimmed)) return trimmed;

    const conn = this.getConnection();
    const url =
      `${this.config.orgUrl}/_apis/identities` +
      `?searchFilter=General&filterValue=${encodeURIComponent(trimmed)}&api-version=6.0`;

    let res;
    try {
      res = await conn.rest.get<{
        value?: Array<{ id?: string; providerDisplayName?: string }>;
      }>(url);
    } catch (e) {
      // On-prem collections whose PAT lacks Identity (Read) scope 401/403 here.
      // Turn the opaque "Failed request: (401)" into an actionable message.
      const status = (e as { statusCode?: number })?.statusCode;
      if (status === 401 || status === 403) {
        throw new Error(
          `Cannot resolve reviewer "${query}" by name — the identities endpoint returned ${status}. ` +
            `This PAT lacks Identity (Read) access on the collection. Pass reviewers as identity GUIDs, ` +
            `or use a PAT that has Identity read scope.`
        );
      }
      throw e;
    }
    const matches = res.result?.value ?? [];

    // Fail loud on ambiguity rather than picking value[0] and silently adding
    // (and notifying) the wrong person. The caller must disambiguate.
    if (matches.length > 1) {
      const names = matches
        .map((m) => m.providerDisplayName)
        .filter(Boolean)
        .slice(0, 5)
        .join(", ");
      throw new Error(
        `"${query}" is ambiguous — it matches ${matches.length} identities` +
          (names ? ` (${names}${matches.length > 5 ? ", …" : ""})` : "") +
          `. Pass a sign-in email/UPN or identity GUID to disambiguate.`
      );
    }

    return matches[0]?.id;
  }
}
