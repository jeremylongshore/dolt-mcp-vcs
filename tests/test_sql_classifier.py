"""Regression suite for the verb-class statement classifier (blocker B1).

Run:  python3 -m unittest tests.test_sql_classifier -v
      (from the repo root; the suite adds scripts/ to sys.path)
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), os.pardir, "scripts"))

from sql_classifier import (  # noqa: E402
    READ, SAFE_WRITE, HISTORY_AFFECTING,
    classify_sql, classify_statement, gate_decision,
)


class TestReadClassification(unittest.TestCase):
    def test_plain_reads(self):
        for sql in [
            "SELECT * FROM issues",
            "  select count(*) from issues  ",
            "SHOW TABLES",
            "DESCRIBE issues",
            "EXPLAIN SELECT 1",
            "USE beads",
            "SELECT * FROM dolt_log",
            "SELECT * FROM dolt_diff_issues",
        ]:
            self.assertEqual(classify_sql(sql), READ, sql)

    def test_cte_select_is_read(self):
        self.assertEqual(
            classify_sql("WITH x AS (SELECT 1) SELECT * FROM x"), READ)

    def test_session_set_is_read(self):
        self.assertEqual(classify_sql("SET autocommit=1"), READ)

    def test_comment_only_is_read(self):
        self.assertEqual(classify_sql("-- just a comment"), READ)
        self.assertEqual(classify_sql("/* nothing here */"), READ)


class TestSafeWriteClassification(unittest.TestCase):
    def test_dml(self):
        for sql in [
            "INSERT INTO issues (id) VALUES ('x')",
            "UPDATE issues SET status='closed' WHERE id='x'",
            "DELETE FROM issues WHERE id='x'",
            "REPLACE INTO issues VALUES ('x')",
            "TRUNCATE TABLE issues",
        ]:
            self.assertEqual(classify_sql(sql), SAFE_WRITE, sql)

    def test_ddl_recoverable_is_safe_write(self):
        for sql in ["CREATE TABLE t (id INT)", "ALTER TABLE t ADD c INT",
                    "DROP TABLE t", "DROP VIEW v", "DROP INDEX i ON t"]:
            self.assertEqual(classify_sql(sql), SAFE_WRITE, sql)

    def test_safe_dolt_procs(self):
        for sql in [
            "CALL DOLT_COMMIT('-m', 'msg')",
            "CALL DOLT_ADD('.')",
            "CALL DOLT_CHECKOUT('-b', 'agent/task')",
            "CALL DOLT_BRANCH('agent/task')",
            "CALL DOLT_RESET('--soft')",
        ]:
            self.assertEqual(classify_sql(sql), SAFE_WRITE, sql)

    def test_cte_with_write_is_safe_write(self):
        self.assertEqual(
            classify_sql("WITH x AS (SELECT 1) DELETE FROM issues WHERE id IN (SELECT 1)"),
            SAFE_WRITE)


class TestHistoryAffectingClassification(unittest.TestCase):
    def test_remote_and_merge(self):
        for sql in [
            "CALL DOLT_PUSH('origin', 'main')",
            "CALL DOLT_PULL('origin')",
            "CALL DOLT_MERGE('agent/task')",
            "CALL DOLT_RESET('--hard')",
            "CALL DOLT_REVERT('HEAD')",
            "CALL DOLT_REBASE('-i', 'main')",
            "CALL DOLT_CLEAN()",
        ]:
            self.assertEqual(classify_sql(sql), HISTORY_AFFECTING, sql)

    def test_branch_and_tag_delete(self):
        self.assertEqual(classify_sql("CALL DOLT_BRANCH('-D', 'agent/task')"), HISTORY_AFFECTING)
        self.assertEqual(classify_sql("CALL DOLT_BRANCH('-d', 'agent/task')"), HISTORY_AFFECTING)
        self.assertEqual(classify_sql("CALL DOLT_TAG('--delete', 'v1')"), HISTORY_AFFECTING)

    def test_destructive_admin(self):
        for sql in ["DROP DATABASE beads", "DROP SCHEMA public",
                    "GRANT ALL ON *.* TO x", "CREATE USER y", "DROP USER y"]:
            self.assertEqual(classify_sql(sql), HISTORY_AFFECTING, sql)

    def test_unknown_call_is_denied(self):
        self.assertEqual(classify_sql("CALL DOLT_FROBNICATE()"), HISTORY_AFFECTING)
        self.assertEqual(classify_sql("CALL some_proc()"), HISTORY_AFFECTING)


class TestInjectionResistance(unittest.TestCase):
    def test_batch_takes_max_severity(self):
        self.assertEqual(
            classify_sql("SELECT 1; CALL DOLT_PUSH('origin','main')"), HISTORY_AFFECTING)
        self.assertEqual(
            classify_sql("SELECT 1; DELETE FROM issues"), SAFE_WRITE)

    def test_hidden_verb_in_comment_does_not_promote(self):
        # A verb hidden in a comment must NOT make a read look dangerous, but more
        # importantly a real verb cannot hide *behind* a comment either.
        self.assertEqual(classify_sql("SELECT 1 /* ; DROP DATABASE x */"), READ)
        self.assertEqual(classify_sql("SELECT 1 -- ; CALL DOLT_RESET('--hard')"), READ)

    def test_comment_cannot_mask_a_real_mutation(self):
        self.assertEqual(classify_sql("/* read? */ DELETE FROM issues"), SAFE_WRITE)
        self.assertEqual(
            classify_sql("/* */ CALL DOLT_PUSH('origin')"), HISTORY_AFFECTING)


class TestGateDecision(unittest.TestCase):
    def test_read_always_allowed(self):
        ok, verb, _ = gate_decision("SELECT 1", allow_mutation=False, branch="main", maturity="ga")
        self.assertTrue(ok)
        self.assertEqual(verb, READ)

    def test_history_always_refused(self):
        ok, verb, _ = gate_decision("CALL DOLT_PUSH('o')", allow_mutation=True,
                                    branch="agent/x", maturity="ga")
        self.assertFalse(ok)
        self.assertEqual(verb, HISTORY_AFFECTING)

    def test_safe_write_needs_allow_mutation(self):
        ok, _, _ = gate_decision("DELETE FROM issues", allow_mutation=False,
                                 branch="agent/x", maturity="ga")
        self.assertFalse(ok)

    def test_safe_write_refused_on_main(self):
        ok, _, reason = gate_decision("DELETE FROM issues", allow_mutation=True,
                                      branch="main", maturity="ga")
        self.assertFalse(ok)
        self.assertIn("agent-owned branch", reason)

    def test_safe_write_allowed_off_main_with_flag(self):
        ok, _, _ = gate_decision("DELETE FROM issues", allow_mutation=True,
                                 branch="agent/task", maturity="ga")
        self.assertTrue(ok)

    def test_pre_ga_blocks_even_safe_write(self):
        for maturity in ("alpha", "experimental"):
            ok, _, reason = gate_decision("INSERT INTO t VALUES (1)", allow_mutation=True,
                                          branch="agent/task", maturity=maturity)
            self.assertFalse(ok, maturity)
            self.assertIn("pre-GA", reason)

    def test_pre_ga_still_allows_read(self):
        ok, _, _ = gate_decision("SELECT 1", allow_mutation=False,
                                 branch="main", maturity="experimental")
        self.assertTrue(ok)


if __name__ == "__main__":
    unittest.main()
