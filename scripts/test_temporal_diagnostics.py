"""Synthetic temporal diagnostics checks; no fabricated operational reports."""
import unittest
from copy import deepcopy
import numpy as np
from test_synoptic_features import fixture
from temporal_diagnostics import classify_front, enrich_temporal, nearest_on_line, occlusion_supported


def front(lon):
    return {'type':'Feature','geometry':{'type':'LineString','coordinates':[[lon,float(y)] for y in np.arange(8,22,.5)]},
            'properties':{'feature_type':'front','label':'Potential frontal boundary','length_km':1500,'evidence':[]}}


class TemporalTests(unittest.TestCase):
    def test_classification_needs_agreement_and_contrast(self):
        self.assertEqual(classify_front(12,8,-3,4),'cold')
        self.assertEqual(classify_front(-12,-8,3,4),'warm')
        self.assertEqual(classify_front(2,2,.2,4),'stationary')
        self.assertEqual(classify_front(12,-8,-3,4),'unclassified')
        self.assertEqual(classify_front(12,8,-3,1),'unclassified')
        self.assertEqual(classify_front(float('nan'),8,-3,4),'unclassified')

    def test_occlusion_requires_all_independent_structure(self):
        self.assertTrue(occlusion_supported({'cold','warm'},True,True,True))
        self.assertFalse(occlusion_supported({'cold'},True,True,True))
        self.assertFalse(occlusion_supported({'cold','warm'},True,True,False))
        self.assertFalse(occlusion_supported({'cold','warm'},False,True,True))

    def test_segment_projection_not_just_nearest_vertex(self):
        distance,point,_=nearest_on_line([2,15],[[0,10],[0,20]])
        self.assertAlmostEqual(point[1],15)
        self.assertAlmostEqual(point[0],0)
        self.assertLess(distance,250)
        distance,_,_=nearest_on_line([179,15],[[-179,10],[-179,20]])
        self.assertLess(distance,250)

    def test_missing_or_stale_previous_analysis_keeps_unclassified(self):
        current={'features':[front(0)],'properties':{}}
        result=enrich_temporal(current,[],{},None,[],None,'2026-10-13T12:00:00Z',None)
        self.assertEqual(result['features'][0]['properties']['front_type'],'unclassified')
        self.assertIn('unavailable',result['properties']['temporal_status'])

    def test_supported_moving_front_and_advection(self):
        for displacement,flow,expected in [(3,8,'cold'),(-3,-8,'warm'),(0,0,'stationary')]:
            def fields(offset): return {'mslp_hpa':lambda x,y:1000+1.5*(x-offset)**2,
                'temperature_c':lambda x,y:15+10*np.tanh(x-offset),
                'dewpoint_c':lambda x,y:5+8*np.tanh(x-offset),
                'u_ms':lambda x,y:np.full_like(x,flow),'v_ms':lambda x,y:np.zeros_like(x)}
            rows,grids=fixture(fields(displacement));old_rows,old_grids=fixture(fields(0))
            current={'features':[front(displacement)],'properties':{}}
            previous={'features':[front(0)],'properties':{}}
            result=enrich_temporal(current,rows,grids,previous,old_rows,old_grids,
                                   '2026-10-13T12:00:00Z','2026-10-13T00:00:00Z')
            self.assertEqual(result['features'][0]['properties']['front_type'],expected)
            self.assertEqual(result['properties']['comparison_hours'],12)
            if flow:
                self.assertTrue(any(f['properties']['feature_type']=='airmass' for f in result['features']))
            sparse=enrich_temporal({'features':[front(displacement)],'properties':{}},rows[:3],grids,previous,old_rows,old_grids,
                                  '2026-10-13T12:00:00Z','2026-10-13T00:00:00Z')
            self.assertEqual(sparse['features'][0]['properties']['front_type'],'unclassified')
            self.assertFalse(any(f['properties']['feature_type']=='airmass' for f in sparse['features']))

    def test_ambiguous_previous_boundaries_do_not_force_type(self):
        rows,grids=fixture({'temperature_c':lambda x,y:15+10*np.tanh(x-3),
              'dewpoint_c':lambda x,y:5+8*np.tanh(x-3),'u_ms':lambda x,y:np.full_like(x,8),'v_ms':lambda x,y:np.zeros_like(x)})
        result=enrich_temporal({'features':[front(3)],'properties':{}},rows,grids,
            {'features':[front(0),front(.1)]},rows,grids,'2026-10-13T12:00:00Z','2026-10-13T00:00:00Z')
        self.assertEqual(result['features'][0]['properties']['front_type'],'unclassified')


if __name__=='__main__': unittest.main()
