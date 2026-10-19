"""Offline archive replay and scoped expert-label evaluation. Never fetches data."""
import argparse
import gzip
import json
import re
import sys
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


def read_chart_directory(root):
    """Package an existing static chart directory in memory, without network IO."""
    root=Path(root);manifest=json.loads((root/'manifest.json').read_text());files={}
    for kind in ('surface','upper'):
        for entry in manifest.get(kind,[]):
            if not re.fullmatch(r'\d{10}',entry['path']):raise ValueError('Invalid chart directory path')
            names=['observations.geojson','features.geojson','features-v5.geojson'] if kind=='surface' else ['soundings.json']
            if kind=='upper':
                for level in manifest.get('levels_hpa',[]):
                    if level not in (925,850,800,700,600,500,400,300,250,200,150,100):raise ValueError('Invalid pressure level')
                    names.extend([f'{level}-observations.geojson',f'{level}-features.geojson'])
            for name in names:
                relative=f'{kind}/{entry["path"]}/{name}';path=root/relative
                if path.exists():files[relative]=json.loads(path.read_text())
    return {'format':'weather-machine-research-archive','schema_version':1,'manifest':manifest,'files':files}


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


def replay(archive,cycle,return_context=False,bounds=None):
    import build_observation_charts as builder
    files=archive['files'];manifest=archive['manifest'];target=datetime.fromisoformat(cycle)
    current=next((e for e in manifest.get('surface',[]) if e['valid_time']==cycle),None)
    if not current:raise ValueError('Selected surface cycle is not in this archive')
    def rows(entry):
        result=[dict(f['properties'],longitude=f['geometry']['coordinates'][0],latitude=f['geometry']['coordinates'][1]) for f in files['surface/'+entry['path']+'/observations.geojson']['features']]
        builder.prepare_surface_pressure(result);wind_components(result)
        return result
    observations=rows(current);grids=builder.diagnostic_grids(observations,'surface',bounds=bounds)
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
        entry=max(older,key=lambda e:e['valid_time']);oldtime=entry['valid_time'];oldrows=rows(entry);oldgrids=builder.diagnostic_grids(oldrows,'surface',bounds=bounds)
        previous=files.get('surface/'+entry['path']+'/features.geojson')
        if previous is None:previous=diagnose(oldrows,oldgrids,'surface',valid_time=oldtime)
    enrich_temporal(result,observations,grids,previous,oldrows,oldgrids,cycle,oldtime,upper)
    result['features'].extend(air_mass_regions(observations,grids,cycle))
    result['properties'].update(valid_time=cycle,feature_count=len(result['features']),offline_replay=True,
        replay_dependency_note='Previous published feature interpretation retained for temporal comparison; preserve its algorithm version')
    context=dict(rows=observations,grids=grids,previous_rows=oldrows,previous_grids=oldgrids,previous_time=oldtime,upper_rows=upper)
    return (result,context) if return_context else result


def replay_pair(archive,cycle,labels=None,bounds=None):
    """Paired policies on the exact same computed fields, not a skill claim."""
    import hashlib
    import build_observation_charts as builder
    from synoptic_v5 import diagnose_v5
    if bounds is not None and labels and labels.get('review_status')=='reviewed':
        box=labels.get('coverage_bbox')
        if not box or not (bounds[0]+5<=box[0]<box[2]<=bounds[2]-5 and bounds[1]+5<=box[1]<box[3]<=bounds[3]-5):
            raise ValueError('Reviewed scope must be inside regional replay bounds with a five-degree edge buffer')
    print('Paired replay: building V4 baseline and common fields',file=sys.stderr,flush=True)
    baseline,context=replay(archive,cycle,return_context=True,bounds=bounds)
    old=None
    if context['previous_time'] and context['previous_grids']:
        print('Paired replay: building independent previous V5 cycle',file=sys.stderr,flush=True)
        old=diagnose_v5(context['previous_rows'],context['previous_grids'],context['previous_time'],
                        upper_rows=context['upper_rows'],smooth=builder.smooth_line)
    print('Paired replay: building current V5 challenger',file=sys.stderr,flush=True)
    challenger=diagnose_v5(context['rows'],context['grids'],cycle,old,context['previous_rows'],context['previous_grids'],
                            context['previous_time'],context['upper_rows'],builder.smooth_line)
    fingerprint=hashlib.sha256(json.dumps({'current':context['rows'],'previous':context['previous_rows'],'upper':context['upper_rows']},sort_keys=True,allow_nan=False).encode()).hexdigest()
    field_digest=hashlib.sha256()
    for period in ('grids','previous_grids'):
        for name,item in sorted((context[period] or {}).items()):
            field_digest.update((period+name).encode())
            if item is None:field_digest.update(b'unavailable');continue
            for array in (item[0],item[1],item[2].filled(np.nan),np.ma.getmaskarray(item[2])):
                value=np.asarray(array);field_digest.update(str(value.shape).encode());field_digest.update(value.tobytes())
    field_fingerprint=field_digest.hexdigest()
    print('Paired replay: comparing geometries and review labels',file=sys.stderr,flush=True)
    changes=[]
    # Automatic correspondences locate disagreements for review, not true/false labels.
    for type_ in ('low','high','trough','ridge','front'):
        a=[f for f in baseline['features'] if f['properties']['feature_type']==type_]
        b=[f for f in challenger['features'] if f['properties']['feature_type']==type_]
        costs=np.array([[geometry_distance(x['geometry'],y['geometry']) for y in b] for x in a])
        pairs=list(zip(*linear_sum_assignment(costs))) if a and b else []
        accepted=[(int(i),int(j),round(float(costs[i,j]),2)) for i,j in pairs if costs[i,j]<=150]
        changes.append({'feature_type':type_,'v4_count':len(a),'v5_count':len(b),'geometric_pairs_within_150km':accepted,
            'v4_unpaired':len(a)-len(accepted),'v5_unpaired':len(b)-len(accepted),
            'front_subtype_disagreements':[{'v4':a[i]['properties'].get('front_type'),'v5':b[j]['properties'].get('front_type'),
                'v4_feature_id':a[i]['properties'].get('feature_id'),'v5_feature_id':b[j]['properties'].get('feature_id')}
                for i,j,_ in accepted if type_=='front' and a[i]['properties'].get('front_type')!=b[j]['properties'].get('front_type')]})
    assessment={engine:evaluate(data['features'],labels,cycle) if labels else {'status':'pending_expert_review','skill_validated':False}
                for engine,data in [('v4',baseline),('v5',challenger)]}
    for data in (baseline,challenger):data['properties'].update(paired_input_sha256=fingerprint,common_fields_sha256=field_fingerprint,analysis_bounds=bounds)
    report={'format':'weather-machine-paired-comparison','valid_time':cycle,'input_sha256':fingerprint,'common_fields_sha256':field_fingerprint,'analysis_bounds':bounds,'evaluations':assessment,
            'disagreements':changes,'skill_validated':False,'coverage_policy':'All returned objects in declared review scope, including provisional/exploratory objects',
            'history_policy':'V4 retains published prior interpretation; V5 recomputes prior cycle without earlier lineage. Occlusion/stationary claims withheld.',
            'note':'Counts and automatic pairs are not accuracy results. Reviewed labels required; track-identity accuracy requires separate lineage reviews.'}
    return baseline,challenger,report


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive',type=Path,nargs='?');parser.add_argument('--surface-time',required=True)
    parser.add_argument('--chart-root',type=Path,help='Use an existing published chart directory instead of a downloaded archive')
    parser.add_argument('--labels',type=Path);parser.add_argument('--output',type=Path,default=Path('tmp/research-replay'))
    parser.add_argument('--compare-v5',action='store_true',help='Write both engines and scoped expert comparisons on identical fields')
    parser.add_argument('--bbox',nargs=4,type=float,metavar=('WEST','SOUTH','EAST','NORTH'),help='Optional bounded offline analysis domain; edge features need caution, not a cropped global replay')
    args=parser.parse_args()
    if bool(args.archive)==bool(args.chart_root):parser.error('Provide exactly one archive or --chart-root')
    archive=read_archive(args.archive) if args.archive else read_chart_directory(args.chart_root)
    from build_observation_charts import write_json
    if args.compare_v5:
        labels=json.loads(args.labels.read_text()) if args.labels else None
        baseline,challenger,report=replay_pair(archive,args.surface_time,labels,bounds=args.bbox)
        write_json(args.output/'features-v4.geojson',baseline);write_json(args.output/'features-v5.geojson',challenger)
        write_json(args.output/'comparison.json',report)
        print(json.dumps({'comparison':str(args.output/'comparison.json'),'skill_validated':False}));return
    result=replay(archive,args.surface_time,bounds=args.bbox)
    write_json(args.output/'features.geojson',result)
    assessment=evaluate(result['features'],json.loads(args.labels.read_text()),args.surface_time) if args.labels else {'status':'pending_expert_review','skill_validated':False}
    write_json(args.output/'evaluation.json',assessment)
    print(json.dumps({'feature_count':len(result['features']),'evaluation':assessment}))


if __name__=='__main__':main()
