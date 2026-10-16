"""Synthetic physical/negative regressions, not expert meteorological validation."""
import json
import unittest
import tempfile
from pathlib import Path
from datetime import datetime
from unittest.mock import patch
import numpy as np
from diagnostic_math import gradients,vector_diagnostics,RADIUS_M
from airmass_regions import prepare_thermodynamics
from feature_tracking import track_features,pressure_tendencies
from replay_observation_case import evaluate
from test_synoptic_features import fixture
from test_temporal_diagnostics import front
from synoptic_features import diagnose
from temporal_diagnostics import enrich_temporal,classify_front


class RefinementTests(unittest.TestCase):
    def test_solid_body_rotation_both_hemispheres_and_seam(self):
        x=np.arange(-180,180,2.);y=np.arange(-70,71,1.);xx,yy=np.meshgrid(x,y)
        omega=1e-5;u=omega*RADIUS_M*np.cos(np.radians(yy));v=xx*0
        d=vector_diagnostics(u,v,x,y)
        np.testing.assert_allclose(d['vorticity'][2:-2],2*omega*np.sin(np.radians(yy))[2:-2],atol=3e-9)
        np.testing.assert_allclose(d['divergence'],0,atol=1e-12)
        np.testing.assert_allclose(d['vorticity'][:,0],d['vorticity'][:,-1])

    def test_scalar_periodic_gradient(self):
        x=np.arange(-180,180,1.);y=np.arange(-50,51,1.);xx,yy=np.meshgrid(x,y)
        gx,_=gradients(np.sin(np.radians(xx)),x,y)
        np.testing.assert_allclose(gx,np.cos(np.radians(xx))/(RADIUS_M*np.cos(np.radians(yy))),atol=2e-11)

    def test_nondivergent_deformation_generates_frontogenesis(self):
        x=np.arange(-5,5.1,.5);y=np.arange(-5,5.1,.5);xx,yy=np.meshgrid(x,y)
        theta=300+xx;u=-xx;v=yy;d=vector_diagnostics(u,v,x,y,theta)
        self.assertGreater(d['frontogenesis_k_100km_3h'][10,10],0)
        self.assertAlmostEqual(d['divergence'][10,10],0,places=12)
        self.assertLess(vector_diagnostics(-u,-v,x,y,theta)['frontogenesis_k_100km_3h'][10,10],0)

    def test_theta_survives_missing_dewpoint(self):
        row={'station_pressure_hpa':1000,'temperature_c':20,'dewpoint_c':None}
        prepare_thermodynamics([row]);self.assertAlmostEqual(row['theta_k'],293.15)
        self.assertIsNone(row['theta_e_k']);self.assertIsNone(row['mixing_ratio_gkg'])

    def test_thermal_front_without_dewpoint_or_pressure(self):
        rows,grids=fixture({'theta_k':lambda x,y:290+10*np.tanh(x),'temperature_c':lambda x,y:15+10*np.tanh(x),
            'u_ms':lambda x,y:-8*np.tanh(x),'v_ms':lambda x,y:6*np.tanh(x)})
        features=diagnose(rows,grids,'surface')['features'];types={f['properties']['feature_type'] for f in features}
        self.assertIn('thermal_boundary',types);self.assertIn('front',types);self.assertNotIn('moisture_boundary',types)
        json.dumps(features,allow_nan=False)

    def test_moisture_boundary_is_not_automatically_front(self):
        rows,grids=fixture({'mixing_ratio_gkg':lambda x,y:8+5*np.tanh(x)})
        types={f['properties']['feature_type'] for f in diagnose(rows,grids,'surface')['features']}
        self.assertIn('moisture_boundary',types);self.assertNotIn('front',types)

    def test_same_station_pressure_actual_interval_and_method(self):
        base=dict(station='A',source='S',latitude=10,longitude=20,mslp_hpa=1000,pressure_method='reported',observed_at='2026-10-16T00:00:00Z')
        now=dict(base,mslp_hpa=1004,observed_at='2026-10-16T04:00:00Z')
        self.assertEqual(pressure_tendencies([now],[base],None,None)['count'],1)
        self.assertEqual(now['pressure_change_hpa_3h'],3)
        self.assertEqual(pressure_tendencies([dict(now,pressure_method='estimated_qnh')],[base],None,None)['count'],0)
        self.assertEqual(pressure_tendencies([dict(now,longitude=21)],[base],None,None)['count'],0)

    def test_track_identity_and_ambiguous_merge(self):
        old={'features':[front(0)]};new={'features':[front(.3)],'properties':{}}
        track_features(new,old,'2026-10-16T03:00:00Z','2026-10-16T00:00:00Z')
        self.assertEqual(new['features'][0]['properties']['track_id'],old['features'][0]['properties']['track_id'])
        newer={'features':[front(.2)]}
        track_features(newer,{'features':[front(0),front(.1)]},'2026-10-16T03:00:00Z','2026-10-16T00:00:00Z')
        self.assertEqual(newer['features'][0]['properties']['tracking_status'],'ambiguous_possible_merge')

    def test_split_children_get_distinct_ids(self):
        new={'features':[front(.2),front(.3)]};old={'features':[front(0)]}
        track_features(new,old,'2026-10-16T03:00:00Z','2026-10-16T00:00:00Z')
        p=[f['properties'] for f in new['features']]
        self.assertNotEqual(p[0]['track_id'],p[1]['track_id']);self.assertEqual(p[0]['parent_track_id'],p[1]['parent_track_id'])

    def test_temperature_change_is_not_hard_type_gate(self):
        self.assertEqual(classify_front(12,8,2,4),'cold');self.assertEqual(classify_front(-12,-8,-2,4),'warm')

    def test_three_hour_typing_without_dewpoint(self):
        def fields(offset):return {'temperature_c':lambda x,y:15+10*np.tanh(x-offset),
            'u_ms':lambda x,y:np.full_like(x,8),'v_ms':lambda x,y:np.zeros_like(x)}
        rows,grids=fixture(fields(1));oldrows,oldgrids=fixture(fields(0))
        result=enrich_temporal({'features':[front(1)],'properties':{}},rows,grids,{'features':[front(0)]},oldrows,oldgrids,
            '2026-10-16T03:00:00Z','2026-10-16T00:00:00Z')
        self.assertEqual(result['features'][0]['properties']['front_type'],'cold');json.dumps(result,allow_nan=False)

    def test_shallow_front_not_vetoed_by_opposite_upper_contrast(self):
        def fields(offset):return {'temperature_c':lambda x,y:15+10*np.tanh(x-offset),
            'u_ms':lambda x,y:np.full_like(x,8),'v_ms':lambda x,y:np.zeros_like(x)}
        rows,grids=fixture(fields(1));oldrows,oldgrids=fixture(fields(0))
        upper=[dict(latitude=lat,longitude=lon,level_hpa=850,temperature_c=20 if lon<1 else 0,observed_at='2026-10-16T00:00:00Z') for lon in (0,2) for lat in (14,15,16)]
        result=enrich_temporal({'features':[front(1)],'properties':{}},rows,grids,{'features':[front(0)]},oldrows,oldgrids,
            '2026-10-16T03:00:00Z','2026-10-16T00:00:00Z',upper)
        p=result['features'][0]['properties'];self.assertEqual(p['front_type'],'cold')
        self.assertEqual(p['vertical_structure_status'],'shallow_or_tilted_or_unresolved')

    def test_builder_writes_v4_diagnostics_and_tendency_products(self):
        import build_observation_charts as builder
        rows,grids=fixture({'mslp_hpa':lambda x,y:1010+x*.1,'temperature_c':lambda x,y:15+np.tanh(x),
            'theta_k':lambda x,y:290+np.tanh(x),'u_ms':lambda x,y:np.full_like(x,8),'v_ms':lambda x,y:np.zeros_like(x)})
        for i,row in enumerate(rows):
            row.update(station=str(i),source='Synthetic fixture',wind_kt=15,wind_from_deg=270,observed_at='2026-10-16T03:00:00Z')
        with tempfile.TemporaryDirectory() as folder,patch.object(builder,'diagnostic_grids',return_value=grids),patch.object(builder,'analysis_grid',return_value=None):
            builder.build_chart(Path(folder),'surface',datetime.fromisoformat('2026-10-16T03:00:00Z'),rows,[],diagnostics_only=True)
            root=Path(folder)/'surface'/'2026101603'
            data=json.loads((root/'features.geojson').read_text())
            self.assertIn('v4',data['properties']['method']);self.assertTrue((root/'pressure-tendency.geojson').exists())
            self.assertIn('python',builder.analysis_software())

    def test_label_template_is_not_expert_validation(self):
        self.assertEqual(evaluate([],{'review_status':'pending_review'},None)['status'],'pending_expert_review')
        with self.assertRaises(ValueError):evaluate([],{'review_status':'reviewed','valid_time':'x'},'x')

    def test_scoped_review_matches_once_and_scores_negative_case(self):
        labels=dict(review_status='reviewed',reviewer='Synthetic test, not expert',valid_time='x',coverage_bbox=[-10,0,10,30],
            reviewed_feature_types=['front'],matching_tolerance_km=100,features=[front(0)])
        result=evaluate([front(.1),front(.2)],labels,'x')
        self.assertEqual(result['true_positive'],1);self.assertEqual(result['false_positive'],1)
        labels['features']=[];self.assertEqual(evaluate([front(0)],labels,'x')['false_positive'],1)


if __name__=='__main__':unittest.main()
