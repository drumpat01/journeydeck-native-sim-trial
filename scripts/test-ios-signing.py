import copy
import datetime
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('signing', Path(__file__).with_name('prepare-ios-signing.py'))
signing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(signing)


class SigningTests(unittest.TestCase):
    def profile(self):
        return {'TeamIdentifier': ['ABCDEFGHIJ'], 'ApplicationIdentifierPrefix': ['ABCDEFGHIJ'],
                'UUID': '12345678-1234-1234-1234-123456789abc',
                'ExpirationDate': datetime.datetime.now() + datetime.timedelta(days=30),
                'ProvisionedDevices': ['SYNTHETIC-DEVICE'], 'Entitlements': {
                    'application-identifier': 'ABCDEFGHIJ.' + signing.MAIN,
                    'get-task-allow': False,
                    'com.apple.developer.icloud-container-identifiers': ['iCloud.' + signing.MAIN],
                    'com.apple.developer.icloud-services': ['CloudKit'],
                    'com.apple.developer.applesignin': ['Default']}}

    def test_correct_profile(self):
        self.assertEqual(signing.validate_profile(self.profile(), signing.MAIN, 'SYNTHETIC-DEVICE'), 'ABCDEFGHIJ')

    def test_reject_wrong_device_identity_expiry_and_distribution(self):
        base = self.profile()
        mutations = [('ProvisionedDevices', ['ANOTHER']), ('ExpirationDate', datetime.datetime(2000, 1, 1)),
                     ('ProvisionsAllDevices', True), ('TeamIdentifier', ['bad']), ('UUID', '../../bad')]
        for key, value in mutations:
            profile = copy.deepcopy(base); profile[key] = value
            with self.assertRaises(ValueError):
                signing.validate_profile(profile, signing.MAIN, 'SYNTHETIC-DEVICE')
        for key, value in [('application-identifier', 'ABCDEFGHIJ.com.journeydeck.recorder'),
                           ('get-task-allow', True), ('com.apple.developer.icloud-container-identifiers', []),
                           ('com.apple.developer.applesignin', [])]:
            profile = copy.deepcopy(base); profile['Entitlements'][key] = value
            with self.assertRaises(ValueError):
                signing.validate_profile(profile, signing.MAIN, 'SYNTHETIC-DEVICE')


if __name__ == '__main__':
    unittest.main()
