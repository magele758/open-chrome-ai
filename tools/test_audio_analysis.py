import unittest
from audio_analysis import partition

class TimelineTest(unittest.TestCase):
    def test_speakers_overlap_and_gaps(self):
        spans=partition([{'start':2,'end':5,'speaker':'A'}, {'start':4,'end':7,'speaker':'B'}],10)
        self.assertEqual([(s['start'],s['end']) for s in spans],[(0,2),(2,4),(4,5),(5,7),(7,10)])
        self.assertEqual(spans[1]['speaker'],'A')
        self.assertTrue(spans[2]['overlap'])
        self.assertIsNone(spans[2]['speaker'])
        self.assertEqual(spans[2]['speakers'],['A','B'])
        self.assertEqual(spans[3]['speaker'],'B')
    def test_no_speech_preserves_duration(self):
        self.assertEqual(partition([],12)[0]['end'],12)
        self.assertEqual(partition([],12)[0]['kind'],'unknown')
    def test_same_speaker_is_stable(self):
        self.assertEqual(len(partition([{'start':0,'end':4,'speaker':'A'}, {'start':4,'end':10,'speaker':'A'}],10)),1)

if __name__=='__main__': unittest.main()
