import json
import unittest

import branch_names


class BranchNamePackTests(unittest.TestCase):
    def test_g4_long_names_are_intentional(self):
        catalog = branch_names.load_catalog()
        g4_ids = {"g4-mares", "g4-stallions", "g4-fillies", "g4-colts", "g4-unspecified"}
        allowed = {
          "apple-brown-betty",
          "big-daddy-mccolt",
          "blazing-donut-glaze",
          "candy-caramel-tooth",
          "chock-full-carafe",
          "clover-the-clever",
          "dane-tee-dove",
          "day-and-spray",
          "feldspar-granite-pie",
          "fleur-de-lis",
          "fleur-de-verre",
          "gallop-j-fry",
          "gusty-the-great",
          "half-baked-apple",
          "hayseed-turnip-truck",
          "hinny-of-the-hills",
          "igneous-rock-pie",
          "kathie-lee-gifford",
          "leonardo-da-brinci",
          "liam-t-walrus",
          "mare-do-well",
          "mare-e-belle",
          "mare-e-lynn",
          "masked-matter-horn",
          "mistress-mare-velous",
          "mr-carrot-cake",
          "mrs-cup-cake",
          "q-t-prism",
          "sew-n-sow",
          "sir-fluffingsworth-von-radishfield",
          "sir-pony-moore",
          "star-swirl-the-bearded",
          "tag-a-long",
          "theodore-donald-donny-kerabatsos",
          "tree-h-hooffield",
          "upper-east-stride"
}

        actual = {
            name
            for pack in catalog["packs"]
            if pack["id"] in g4_ids
            for name in pack["names"]
            if len(name.split("-")) > 2
        }
        self.assertEqual(actual, allowed)
        for noisy in (
            "executive-producer-story-editornicole-dubuc",
            "knowledgeable-shopperwhite-lightning",
            "cruise-pony-3forceful-parent-ponysun-cloche",
            "alicorn-royal-guards",
        ):
            self.assertFalse(any(noisy in pack["names"] for pack in catalog["packs"]))

    def test_builtin_catalog_has_unique_names_across_packs(self):
        catalog = branch_names.load_catalog()
        seen = {}
        for pack in catalog["packs"]:
            for name in pack["names"]:
                self.assertNotIn(
                    name,
                    seen,
                    f"{name} appears in both {seen.get(name)} and {pack['id']}",
                )
                seen[name] = pack["id"]

        self.assertIn("button-mash", next(pack for pack in catalog["packs"] if pack["id"] == "g4-colts")["names"])
        self.assertIn("clean-sweep", next(pack for pack in catalog["packs"] if pack["id"] == "g4-stallions")["names"])
        self.assertNotIn("game-playin-schoolponybutton-mash", seen)
        self.assertNotIn("janitor-ponyclean-sweep", seen)
        self.assertIn("dr-whooves", next(pack for pack in catalog["packs"] if pack["id"] == "g4-stallions")["names"])
        self.assertNotIn("the-tenth-doctor-doctor-whooves-3", seen)
        self.assertNotIn("wavy-haired-pegasusthe-tenth-doctor-doctor-whooves-3", seen)
    def test_builtin_catalog_has_expected_packs_and_names(self):
        catalog = branch_names.load_catalog()
        packs = {pack["id"]: pack for pack in catalog["packs"]}

        self.assertEqual(
            set(packs),
            {
                "g4-mares",
                "g4-stallions",
                "g4-fillies",
                "g4-colts",
                "g4-unspecified",
                "g4-creatures",
                "equestria-girls",
                "g5-main",
                "tamers12345",
                "princewhateverer",
                "fandom-ocs",
                "mlp-4chan",
                "con-mascots",
                "fallout-equestria",
            },
        )
        g4_total = sum(
            len(packs[pack_id]["names"])
            for pack_id in (
                "g4-mares",
                "g4-stallions",
                "g4-fillies",
                "g4-colts",
                "g4-unspecified",
            )
        )
        self.assertEqual(g4_total, 1404)
        self.assertIn("night-glider", packs["g4-mares"]["names"])
        self.assertIn("rainy-day", packs["g4-mares"]["names"])
        self.assertIn("tempest-shadow", packs["g4-mares"]["names"])
        self.assertIn("fizzlepop-berrytwist", packs["g4-mares"]["names"])
        self.assertIn("chancellor-neighsay", packs["g4-stallions"]["names"])
        self.assertIn("twist", packs["g4-fillies"]["names"])
        self.assertIn("aloe-vera", packs["g4-mares"]["names"])
        self.assertEqual(
            packs["g4-mares"]["sources"]["aloe-vera"],
            "https://mlp.fandom.com/wiki/Credits/Season_nine#Deep_Tissue_Memories",
        )
        self.assertIn("spike", packs["g4-creatures"]["names"])
        self.assertIn("gilda", packs["g4-creatures"]["names"])
        self.assertIn("capper-dapperpaws", packs["g4-creatures"]["names"])
        self.assertNotIn("capper", packs["g4-creatures"]["names"])
        self.assertIn("queen-novo", packs["g4-creatures"]["names"])
        self.assertIn("pipp-petals", packs["g5-main"]["names"])
        self.assertEqual(
            set(packs["equestria-girls"]["names"]),
            {
                "principal-cinch",
                "adagio-dazzle",
                "aria-blaze",
                "sonata-dusk",
                "sour-sweet",
                "sunny-flare",
                "indigo-zap",
                "sugarcoat",
                "lemon-zest",
                "flash-sentry",
                "gloriosa-daisy",
                "timber-spruce",
                "juniper-montage",
                "wallflower-blush",
                "vignette-valencia",
                "kiwi-lollipop",
                "supernova-zap",
            },
        )
        self.assertIn("buttons-mom", packs["fandom-ocs"]["names"])
        self.assertNotIn("yona-yak", packs["g4-creatures"]["names"])
        self.assertIn("anonfilly", packs["mlp-4chan"]["names"])
        self.assertIn("snowpity", packs["mlp-4chan"]["names"])
        self.assertIn("milkmare-of-trottingham", packs["mlp-4chan"]["names"])
        self.assertIn("heavy-halbard", packs["mlp-4chan"]["names"])
        self.assertIn("righty-tighty", packs["mlp-4chan"]["names"])
        self.assertIn("bijou-butterfly", packs["mlp-4chan"]["names"])
        for excluded in ("anon", "anonpony", "aryanne"):
            self.assertNotIn(excluded, packs["mlp-4chan"]["names"])
        for mascot in (
            "harmonic-tune",
            "harmony-star",
            "caramel-malt",
            "barley-tender",
            "fizzy-glitch",
            "fair-flyer",
            "morning-mimosa",
            "matinee",
            "soiree",
            "fun-raiser",
        ):
            self.assertIn(mascot, packs["con-mascots"]["names"])

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
                    '[{"id":"g4-mares","label":"Conflict","names":["other"]}]'
                ),
            )


if __name__ == "__main__":
    unittest.main()
