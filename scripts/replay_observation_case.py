"""Offline archive replay and scoped expert-label evaluation. Never fetches data."""
import argparse
import gzip
import json
from pathlib import Path
from datetime import datetime
import numpy as np
from scipy.optimize import linear_sum_assignment
from synoptic_features import diagnose, wind_components, distance_km
from temporal_diagnostics import enrich_temporal,nearest_on_line
from airmass_regions import air_mass_regions


def read_archive(path):
    data=Path(path).read_bytes()
    if data[:2]==b'\x1f\x8b':data=gzip.decompress(data)
    archive=json.loads(data)
    if archive.get('format')!='weather-machine-research-archive' or archive.get('schema_version')!=1:
        raise ValueError('Unsupported research archive format')
    if not isinstance(archive.get('files'),dict):raise ValueError('Archive files missing')
    # Files remain in memory: no extraction of archive-controlled paths.
    return archive


def geometry_distance(a,b):
    if a['type']!=b['type']:return 1e9
    if a['type']=='Point':return distance_km(a['coordinates'],b['coordinates'])
    if a['type']!='LineString':return 1e9
    def sample(line):return [line[i] for i in sorted(set(np.linspace(0,len(line)-1,min(12,len(line))).astype(int)))]
    distances=[nearest_on_line(p,b['coordinates'])[0] for p in sample(a['coordinates'])]
    distances += [nearest_on_line(p,a['coordinates'])[0] for p in sample(b['coordinates'])]
    return float(np.mean(distances))


def evaluate(features,labels,valid_time):
    if labels.get('review_status')!='reviewed':
        return {'status':'pending_expert_review','skill_validated':False}
    if labels.get('valid_time')!=valid_time:raise ValueError('Label valid time differs from replay')
    bbox=labels.get('coverage_bbox');types=labels.get('reviewed_feature_types')
    if not bbox or len(bbox)!=4 or not types or not labels.get('reviewer'):
        raise ValueError('Reviewed labels require reviewer, coverage_bbox and reviewed_feature_types')
    def inside(geometry):
        coords=[geometry['coordinates']] if geometry['type']=='Point' else geometry['coordinates'] if geometry['type']=='LineString' else []
        return bool(coords) and all(bbox[0]<=p[0]<=bbox[2] and bbox[1]<=p[1]<=bbox[3] for p in coords)
    predicted=[f for f in features if f['properties'].get('feature_type') in types and inside(f['geometry'])]
    expected=labels.get('features',[])
    if any(f['properties'].get('feature_type') not in types or not inside(f['geometry']) for f in expected):raise ValueError('Labels outside declared review scope')
    tolerance=float(labels.get('matching_tolerance_km',100))
    if tolerance<=0:raise ValueError('Matching tolerance must be positive')
    costs=np.full((len(predicted),len(expected)),1e9)
    for i,a in enumerate(predicted):
        for j,b in enumerate(expected):
            if a['properties']['feature_type']==b['properties']['feature_type']:
                costs[i,j]=geometry_distance(a['geometry'],b['geometry'])
    pairs=list(zip(*linear_sum_assignment(costs))) if costs.size else []
    matches=[(int(i),int(j),round(float(costs[i,j]),2)) for i,j in pairs if costs[i,j]<=tolerance]
    subtype=[(predicted[i]['properties'].get('front_type'),expected[j]['properties']['front_type']) for i,j,_ in matches if expected[j]['properties'].get('front_type')]
    return {'status':'scoped_expert_comparison','reviewer':labels['reviewer'],'coverage_bbox':bbox,
        'scope_rule':'Only features wholly inside review box and declared types are scored; crossing features excluded',
        'matching_tolerance_km':tolerance,'matches':matches,'true_positive':len(matches),
        'false_positive':len(predicted)-len(matches),'false_negative':len(expected)-len(matches),
        'mean_matched_distance_km':float(np.mean([m[2] for m in matches])) if matches else None,
        'front_subtype_pairs':subtype,'skill_validated':False,'note':'One scoped case is not general validation; use independent held-out cases and negative cases'}


def replay(archive,cycle):
    import build_observation_charts as builder
    files=archive['files'];manifest=archive['manifest'];target=datetime.fromisoformat(cycle)
    current=next((e for e in manifest.get('surface',[]) if e['valid_time']==cycle),None)
    if not current:raise ValueError('Selected surface cycle is not in this archive')
    def rows(entry):
        result=[dict(f['properties'],longitude=f['geometry']['coordinates'][0],latitude=f['geometry']['coordinates'][1]) for f in files['surface/'+entry['path']+'/observations.geojson']['features']]
        builder.prepare_surface_pressure(result);wind_components(result)
        return result
    observations=rows(current);grids=builder.diagnostic_grids(observations,'surface')
    upper=[]
    for entry in manifest.get('upper',[]):
        if not 0<=(target-datetime.fromisoformat(entry['valid_time'])).total_seconds()<=43200:continue
        base='upper/'+entry['path']+'/'
        if base+'soundings.json' in files:
            upper.extend(dict(row,station=profile['station'],latitude=profile['latitude'],longitude=profile['longitude'],observed_at=row.get('observed_at',profile['observed_at'])) for profile in files[base+'soundings.json']['profiles'] for row in profile['levels'])
        else:
            for level in manifest.get('levels_hpa',[]):
                upper.extend(dict(f['properties'],longitude=f['geometry']['coordinates'][0],latitude=f['geometry']['coordinates'][1]) for f in files.get(base+str(level)+'-observations.geojson',{}).get('features',[]))
    result=diagnose(observations,grids,'surface',smooth=builder.smooth_line,upper_rows=upper,valid_time=cycle)
    older=[e for e in manifest.get('surface',[]) if 10800<=(target-datetime.fromisoformat(e['valid_time'])).total_seconds()<=64800]
    previous=None;oldrows=[];oldgrids=None;oldtime=None
    if older:
        entry=max(older,key=lambda e:e['valid_time']);oldtime=entry['valid_time'];oldrows=rows(entry);oldgrids=builder.diagnostic_grids(oldrows,'surface')
        previous=files.get('surface/'+entry['path']+'/features.geojson')
        if previous is None:previous=diagnose(oldrows,oldgrids,'surface',valid_time=oldtime)
    enrich_temporal(result,observations,grids,previous,oldrows,oldgrids,cycle,oldtime,upper)
    result['features'].extend(air_mass_regions(observations,grids,cycle))
    result['properties'].update(valid_time=cycle,feature_count=len(result['features']),offline_replay=True,
        replay_dependency_note='Previous published feature interpretation retained for temporal comparison; preserve its algorithm version')
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive',type=Path);parser.add_argument('--surface-time',required=True)
    parser.add_argument('--labels',type=Path);parser.add_argument('--output',type=Path,default=Path('tmp/research-replay'))
    args=parser.parse_args();archive=read_archive(args.archive);result=replay(archive,args.surface_time)
    from build_observation_charts import write_json
    write_json(args.output/'features.geojson',result)
    assessment=evaluate(result['features'],json.loads(args.labels.read_text()),args.surface_time) if args.labels else {'status':'pending_expert_review','skill_validated':False}
    write_json(args.output/'evaluation.json',assessment)
    print(json.dumps({'feature_count':len(result['features']),'evaluation':assessment}))


if __name__=='__main__':main()
