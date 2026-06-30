"""Seam proof for the use-case-adapter inversion (schema-profile MAJOR / §9).

The SAME SQL builder, run against TWO different schema profiles (beads + a
throwaway generic schema that renames everything), must produce correct queries
with zero code change. That is the proof that beads is a profile, not a hardcode.

Run:  python3 -m unittest tests.test_profile_sql -v
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), os.pardir, "scripts"))
from profile_sql import (  # noqa: E402
    load_profile, epic_closure_sql, bottleneck_sql,
)

_PROFILES = os.path.join(os.path.dirname(__file__), os.pardir, "profiles")
BEADS = load_profile(os.path.join(_PROFILES, "beads.profile.json"))
GENERIC = load_profile(os.path.join(_PROFILES, "example-generic.profile.json"))


class TestBeadsProfile(unittest.TestCase):
    def test_epic_closure_uses_beads_names(self):
        sql = epic_closure_sql(BEADS)
        for token in ["FROM issues e", "JOIN dependencies d", "d.issue_id", "d.depends_on_id",
                      "'closed'", "'epic'", "'parent-child'"]:
            self.assertIn(token, sql, token)
        self.assertIn("HAVING children>0 AND closed=children", sql)

    def test_bottleneck_uses_beads_names(self):
        sql = bottleneck_sql(BEADS, top=5)
        for token in ["FROM dependencies d", "JOIN issues b", "'blocks'", "LIMIT 5"]:
            self.assertIn(token, sql, token)


class TestGenericProfileSeam(unittest.TestCase):
    """The throwaway schema renames everything — the builder must follow the profile."""

    def test_epic_closure_uses_generic_names(self):
        sql = epic_closure_sql(GENERIC)
        for token in ["FROM work_items e", "JOIN links d", "d.from_item", "d.to_item",
                      "'done'", "'group'", "'contains'"]:
            self.assertIn(token, sql, token)
        # and must NOT contain any beads name
        for absent in ["issues e", "depends_on_id", "'closed'", "'epic'", "'parent-child'"]:
            self.assertNotIn(absent, sql, absent)

    def test_bottleneck_uses_generic_names(self):
        sql = bottleneck_sql(GENERIC, top=3)
        for token in ["FROM links d", "JOIN work_items b", "'needs'", "LIMIT 3"]:
            self.assertIn(token, sql, token)
        self.assertNotIn("'blocks'", sql)


class TestProfileIsUntrustedInput(unittest.TestCase):
    def test_malicious_identifier_rejected(self):
        evil = dict(BEADS)
        evil["tables"] = dict(BEADS["tables"], issues="issues`; DROP TABLE x; --")
        with self.assertRaises(ValueError):
            epic_closure_sql(evil)

    def test_malicious_value_is_escaped_not_injected(self):
        evil = dict(BEADS)
        evil["closed-value"] = "x' OR '1'='1"
        sql = epic_closure_sql(evil)
        # the quote is doubled (escaped), not left to break out of the literal
        self.assertIn("'x'' OR ''1''=''1'", sql)

    def test_bottleneck_top_must_be_positive_int(self):
        for bad in [0, -1, "10; DROP", 1.5]:
            with self.assertRaises(ValueError):
                bottleneck_sql(BEADS, top=bad)


if __name__ == "__main__":
    unittest.main()
