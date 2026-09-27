import json
import unittest

import branch_names


class BranchNamePackTests(unittest.TestCase):
    def test_builtin_catalog_has_expected_packs_and_names(self):
        catalog = branch_names.load_catalog()
        packs = {pack["id"]: pack for pack in catalog["packs"]}

        self.assertEqual(
            set(packs),
            {
                "g4-ponies",
                "g4-creatures",
                "g5-main",
                "tamers12345",
                "princewhateverer",
                "fandom-ocs",
                "fallout-equestria",
            },
        )
        self.assertGreaterEqual(len(packs["g4-ponies"]["names"]), 1400)
        self.assertIn("aloe-vera", packs["g4-ponies"]["names"])
        self.assertEqual(
            packs["g4-ponies"]["sources"]["aloe-vera"],
            "https://mlp.fandom.com/wiki/Credits/Season_nine#Deep_Tissue_Memories",
        )
        self.assertIn("spike", packs["g4-creatures"]["names"])
        self.assertIn("gilda", packs["g4-creatures"]["names"])
        self.assertIn("pipp-petals", packs["g5-main"]["names"])
        self.assertNotIn("yona-yak", packs["g4-creatures"]["names"])

    def test_imports_accept_single_pack_array_or_catalog_object(self):
        pack = {"id": "friends", "label": "Friends", "names": ["one", "two"]}
        self.assertEqual(
            branch_names.parse_imported_packs(json.dumps(pack))[0]["id"],
            "friends",
        )
        self.assertEqual(
            branch_names.parse_imported_packs(json.dumps([pack]))[0]["id"],
            "friends",
        )
        self.assertEqual(
            branch_names.parse_imported_packs(json.dumps({"packs": [pack]}))[0]["id"],
            "friends",
        )

    def test_runtime_settings_merge_packs_and_custom_names(self):
        settings = {
            "branchNameDisabledPacks": "g4-creatures",
            "branchCustomNames": "my-oc,second-oc",
            "branchNameImports": '[{"id":"friends","label":"Friends","names":["other-oc"]}]',
        }

        runtime = branch_names.resolve_runtime_settings(settings)

        self.assertIn("g4-creatures", runtime["branchNameDisabledPacks"])
        self.assertEqual(runtime["branchCustomNames"], ["my-oc", "second-oc"])
        self.assertIn(
            "friends",
            {pack["id"] for pack in runtime["branchNamePacks"]},
        )
        self.assertNotIn("branchNameImports", runtime)

    def test_rejects_conflicting_import_id(self):
        with self.assertRaisesRegex(ValueError, "conflicts with a built-in pack"):
            branch_names.merge_catalog(
                branch_names.load_catalog(),
                branch_names.parse_imported_packs(
                    '[{"id":"g4-ponies","label":"Conflict","names":["other"]}]'
                ),
            )


if __name__ == "__main__":
    unittest.main()
