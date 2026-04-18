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
}
