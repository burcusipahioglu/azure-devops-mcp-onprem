export interface Config {
  orgUrl: string;
  pat: string;
  project: string;
  sslIgnore: boolean;
  serverName: string;
}

/**
 * Extract server name from Azure DevOps URL or use provided name
 * Examples:
 *   https://dev.azure.com/mycompany → "mycompany"
 *   https://my-tfs.example.com/tfs/MyOrg → "MyOrg"
 *   (custom name via env var)
 */
function deriveServerName(orgUrl: string, customName?: string): string {
  if (customName) {
    return customName;
  }

  // Azure DevOps Cloud: https://dev.azure.com/organization
  if (orgUrl.includes("dev.azure.com")) {
    const match = orgUrl.match(/dev\.azure\.com\/([^/]+)/);
    if (match?.[1]) {
      return match[1];
    }
  }

  // On-prem: https://server/tfs/organization or https://server/organization
  const urlObj = new URL(orgUrl);
  const parts = urlObj.pathname.split("/").filter(Boolean);

  if (parts.length > 0) {
    // Last non-empty path segment is likely the org/project name
    return parts[parts.length - 1];
  }

  // Fallback: hostname
  return urlObj.hostname.split(".")[0];
}

export function loadConfig(): Config {
  const orgUrl = process.env.AZURE_DEVOPS_ORG_URL;
  const pat = process.env.AZURE_DEVOPS_PAT;
  const project = process.env.AZURE_DEVOPS_PROJECT;
  const customServerName = process.env.AZURE_DEVOPS_SERVER_NAME;

  const missing: string[] = [];
  if (!orgUrl) missing.push("AZURE_DEVOPS_ORG_URL");
  if (!pat) missing.push("AZURE_DEVOPS_PAT");
  if (!project) missing.push("AZURE_DEVOPS_PROJECT");

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }

  // Safe to assert — validation above guarantees these are defined
  const resolvedOrgUrl = orgUrl as string;
  const serverName = deriveServerName(resolvedOrgUrl, customServerName);

  return {
    orgUrl: resolvedOrgUrl,
    pat: pat as string,
    project: project as string,
    sslIgnore:
      process.env.AZURE_DEVOPS_SSL_IGNORE?.toLowerCase() === "true",
    serverName,
  };
}
