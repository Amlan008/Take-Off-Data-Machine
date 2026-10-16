"""Deterministic feature lineage and timestamp-aware matched-station tendencies."""
import math
import uuid
from datetime import datetime
import numpy as np


def hours_between(later,earlier):
    try:return (datetime.fromisoformat(later)-datetime.fromisoformat(earlier)).total_seconds()/3600
    except (ValueError,TypeError):return None


def feature_id(feature,time):
    p=feature['properties'];g=feature['geometry']
    identity=repr((time,p.get('feature_type'),p.get('level_hpa'),g))
    return str(uuid.uuid5(uuid.NAMESPACE_URL,identity))


def track_features(current,previous,time,previous_time):
    from synoptic_features import distance_km
    from temporal_diagnostics import nearest_on_line
    hours=hours_between(time,previous_time)
    old=(previous or {}).get('features',[])
    for f in old:f['properties'].setdefault('track_id',feature_id(f,previous_time))
    claims={}
    for feature in current.get('features',[]):
        p=feature['properties'];p['feature_id']=feature_id(feature,time)
        p.update(track_id=p['feature_id'],tracking_status='new_or_unmatched')
        if hours is None or not 0<hours<=18:continue
        matches=[]
        for f in old:
            if f['properties'].get('feature_type')!=p.get('feature_type') or f['geometry']['type']!=feature['geometry']['type']:continue
            if f['geometry']['type']=='Point':distance=distance_km(feature['geometry']['coordinates'],f['geometry']['coordinates'])
            elif f['geometry']['type']=='LineString':
                line=feature['geometry']['coordinates'];samples=[line[i] for i in sorted(set(np.linspace(0,len(line)-1,min(5,len(line))).astype(int)))]
                distances=[nearest_on_line(pt,f['geometry']['coordinates']) for pt in samples]
                distance=float(np.median([m[0] for m in distances if m])) if any(distances) else math.inf
            else:continue
            if distance<=min(650,max(150,hours*90)):matches.append((distance,f))
        matches.sort(key=lambda item:item[0])
        if not matches:continue
        parents=[f['properties']['track_id'] for distance,f in matches if distance<=matches[0][0]+50]
        p['candidate_parent_track_ids']=parents
        if len(parents)>1:
            p['tracking_status']='ambiguous_possible_merge';continue
        distance,old_feature=matches[0];parent=parents[0]
        p.update(track_id=parent,previous_feature_id=old_feature['properties'].get('feature_id',feature_id(old_feature,previous_time)),
                 tracking_status='matched_candidate',tracking_distance_km=round(distance),comparison_hours=hours,previous_time=previous_time)
        claims.setdefault(parent,[]).append(p)
    for group in claims.values():
        if len(group)>1:
            for p in group:
                p.update(track_id=p['feature_id'],parent_track_id=p['track_id'],tracking_status='possible_split_or_ambiguous_match')
    current.setdefault('properties',{})['tracking_method']='Proximity/shape candidate lineage, not verified trajectories; ambiguous splits/merges retained'


def pressure_tendencies(rows,previous_rows,time,previous_time):
    from synoptic_features import distance_km
    previous={ (r.get('source'),r.get('station')):r for r in previous_rows if r.get('station') }
    values=[]
    for row in rows:
        for key in ('pressure_change_hpa_3h','pressure_change_interval_hours','pressure_change_previous_time'):row.pop(key,None)
        before=previous.get((row.get('source'),row.get('station')))
        if not before or row.get('mslp_hpa') is None or before.get('mslp_hpa') is None:continue
        if distance_km([row['longitude'],row['latitude']],[before['longitude'],before['latitude']])>5:continue
        if row.get('pressure_method')!=before.get('pressure_method'):continue
        hours=hours_between(row.get('observed_at'),before.get('observed_at'))
        if hours is None or not 1<=hours<=18:continue
        value=(row['mslp_hpa']-before['mslp_hpa'])*3/hours
        row.update(pressure_change_hpa_3h=round(value,2),pressure_change_interval_hours=round(hours,3),
                   pressure_change_previous_time=before['observed_at'])
        values.append({'station':row['station'],'source':row.get('source'),'longitude':row['longitude'],'latitude':row['latitude'],
                       'pressure_change_hpa_3h':round(value,2),'actual_interval_hours':round(hours,3),'pressure_method':row.get('pressure_method')})
    return {'method':'Same station/source within 5 km; consistent pressure method; actual report timestamps; normalised to 3 h',
            'count':len(values),'stations':values,'not_system_central_pressure_tendency':True}
