"""Subtitle timing is not evidence of a shared speaker identity."""
import unittest
import media_helper as helper


class SubtitleMetadataTests(unittest.TestCase):
    def test_json3_does_not_invent_speaker(self):
        cues = helper.parse_json3_cues({'events': [
            {'tStartMs': 0, 'dDurationMs': 4000, 'segs': [{'utf8': 'Hello everyone.'}]},
            {'tStartMs': 5000, 'dDurationMs': 4000, 'segs': [{'utf8': 'Hello everyone.'}]},
        ]})
        self.assertEqual(len(cues), 2)
        self.assertTrue(all(c['speaker'] is None for c in cues))
        self.assertEqual(cues[0]['src'], cues[1]['src'])  # genuine repetition stays

    def test_vtt_does_not_invent_speaker(self):
        cues = helper.parse_vtt_srt_cues('WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nFirst person.\n\n00:00:04.000 --> 00:00:08.000\nSecond person.\n')
        self.assertEqual(len(cues), 2)
        self.assertTrue(all(c['speaker'] is None for c in cues))


if __name__ == '__main__':
    unittest.main()
