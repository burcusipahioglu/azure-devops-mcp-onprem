import type { IWorkItemTrackingApi } from "azure-devops-node-api/WorkItemTrackingApi.js";
import type { IGitApi } from "azure-devops-node-api/GitApi.js";
import type { IBuildApi } from "azure-devops-node-api/BuildApi.js";
import type { IReleaseApi } from "azure-devops-node-api/ReleaseApi.js";
import type { ITfvcApi } from "azure-devops-node-api/TfvcApi.js";
import type { ITestApi } from "azure-devops-node-api/TestApi.js";
import type { ITestPlanApi } from "azure-devops-node-api/TestPlanApi.js";
import type { IWikiApi } from "azure-devops-node-api/WikiApi.js";

export interface WorkItemContext {
  api: IWorkItemTrackingApi;
  project: string;
  orgUrl: string;
}

export interface GitContext {
  api: IGitApi;
  project: string;
}

export interface TfvcContext {
  api: ITfvcApi;
  project: string;
}

export interface BuildContext {
  api: IBuildApi;
  project: string;
}

export interface ReleaseContext {
  api: IReleaseApi;
  project: string;
}

export interface TestContext {
  api: ITestApi;
  project: string;
}

export interface TestPlanContext {
  api: ITestPlanApi;
  project: string;
}

export interface WikiContext {
  api: IWikiApi;
  project: string;
}
