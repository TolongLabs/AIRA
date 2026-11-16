-- A group message names its sender before the scope marker (docs/trd/system.md#gateway-contract). The name is
-- kept on the identity, so the model can call members by name and a mention can be written as @<name>.
ALTER TABLE identity ADD COLUMN display_name TEXT;
