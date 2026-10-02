import unittest

import codex_image_drop


class ImageDropPatchTests(unittest.TestCase):
    def test_install_is_idempotent_and_uninstall_restores_listeners(self):
        original = (
            'function hook(){const config={dragCounterRef:counter};'
            'if(root!=null)return '
            'root.addEventListener(`dragenter`,enter,!0),'
            'root.addEventListener(`dragover`,enter,!0),'
            'root.addEventListener(`dragleave`,leave,!0),'
            'root.addEventListener(`drop`,drop,!0),()=>{'
            'root.removeEventListener(`dragenter`,enter,!0),'
            'root.removeEventListener(`dragover`,enter,!0),'
            'root.removeEventListener(`dragleave`,leave,!0),'
            'root.removeEventListener(`drop`,drop,!0)}}'
        )
        patched = codex_image_drop.transform(original)
        self.assertIn('return scmToolkitRegisterImageDropTarget(root,enter,leave,drop)', patched)
        self.assertEqual(codex_image_drop.transform(patched), patched)
        self.assertEqual(codex_image_drop.transform(patched, remove=True), original)

    def test_other_bundles_remain_unchanged(self):
        self.assertEqual(codex_image_drop.transform('other bundle'), 'other bundle')

    def test_changed_listener_contract_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Unsupported Codex build'):
            codex_image_drop.transform('const config={dragCounterRef:counter};')
