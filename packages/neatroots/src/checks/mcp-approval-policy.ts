export class McpManualApplicationError extends Error {
  constructor(readonly targetPath: string) {
    super(`Manual application required: ${targetPath} already exists. Review the proposal in the check editor and save it explicitly as your own check, then reject the obsolete proposal. Approval never overwrites an existing file.`);
  }
}
