# Pull request rules

## AI assistance disclosure

Every pull request must explicitly state whether AI assistance was used.
If it was, truthfully list every model used, including the model name and
version where available. A tool name such as an editor or coding assistant
does not replace the model name. Do not guess or invent model information;
explicitly disclose any unavailable details.

## Patch implementation

New or modified patches must use AST (Abstract Syntax Tree) matching and
transformation. Do not implement patches with regular-expression matching
or replacement. This requirement applies to patch logic, not unrelated
uses of regular expressions.

Complete the pull request template before requesting review. Mark the patch
requirement as not applicable only when the PR does not add or modify patches.
