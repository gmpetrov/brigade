-- The audit log, the run log and the connector call log are append-only
-- (spec hard constraint 6). Rows can only be removed together with their
-- workspace, by cascade.
CREATE FUNCTION brigade_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD; -- cascade from deleting the parent workspace or thread
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditEntry_append_only" BEFORE UPDATE OR DELETE ON "AuditEntry"
  FOR EACH ROW EXECUTE FUNCTION brigade_append_only();
CREATE TRIGGER "SessionEvent_append_only" BEFORE UPDATE OR DELETE ON "SessionEvent"
  FOR EACH ROW EXECUTE FUNCTION brigade_append_only();
CREATE TRIGGER "ConnectionCall_append_only" BEFORE UPDATE OR DELETE ON "ConnectionCall"
  FOR EACH ROW EXECUTE FUNCTION brigade_append_only();
