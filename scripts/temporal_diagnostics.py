"""Conservative, experimental temporal fronts and thermal/moisture advection.

These heuristics do not establish official fronts or Lagrangian air-mass tracks.
All comparisons require two compatible, observation-supported snapshots.
"""
import math
from datetime import datetime
import numpy as np
from scipy.ndimage import binary_erosion
from synoptic_features import distance_km, gradients, support


def nearest_on_line(point, line):
    """Local tangent-plane projection, with longitude wrapping."""
    lat, lon = point[1], point[0]
    cosine = max(.2, math.cos(math.radians(lat)))
    def local(p):
        return np.array([((p[0]-lon+180) % 360-180)*111.195*cosine, (p[1]-lat)*111.195])
    best = None
    for a, b in zip(line[:-1], line[1:]):
        aa, bb = local(a), local(b)
        delta = bb-aa
        fraction = np.clip(-np.dot(aa, delta)/max(np.dot(delta, delta), 1e-9), 0, 1)
        q = aa+fraction*delta
        candidate = (float(np.linalg.norm(q)), [lon+q[0]/(111.195*cosine), lat+q[1]/111.195], delta)
        if best is None or candidate[0] < best[0]: best = candidate
    return best


def classify_front(normal_speed_kt, normal_flow_kt, temperature_change, contrast):
    """Positive normal is toward warmer air: advancing cold air gives cold front."""
    if contrast < 2 or not all(math.isfinite(v) for v in (normal_speed_kt, normal_flow_kt, temperature_change)):
        return 'unclassified'
    if abs(normal_speed_kt) <= 5 and abs(normal_flow_kt) <= 5 and abs(temperature_change) < 2:
        return 'stationary'
    if normal_speed_kt > 5 and normal_flow_kt > 2 and temperature_change <= -1:
        return 'cold'
    if normal_speed_kt < -5 and normal_flow_kt < -2 and temperature_change >= 1:
        return 'warm'
    return 'unclassified'


def occlusion_supported(previous_types, near_low, surface_cool_both_sides, warm_aloft):
    # Require previous distinct cold/warm arms plus surface and elevated structure.
    return {'cold', 'warm'}.issubset(previous_types) and near_low and surface_cool_both_sides and warm_aloft


def enrich_temporal(current, rows, grids, previous, previous_rows, previous_grids, current_time, previous_time, upper_rows=None):
    status = current.setdefault('properties', {})
    status['front_classification'] = 'Experimental temporal candidates; ambiguous boundaries remain unclassified'
    fronts = [f for f in current['features'] if f['properties']['feature_type'] == 'front']
    for front in fronts:
        front['properties'].update(front_type='unclassified', label='Unclassified front candidate')
    hours = (datetime.fromisoformat(current_time)-datetime.fromisoformat(previous_time)).total_seconds()/3600 if previous_time else 0
    if not previous or not previous_grids or not 6 <= hours <= 18:
        status['temporal_status'] = 'No compatible previous analysis 6–18 hours earlier; temporal layers unavailable'
        return current
    status.update(previous_time=previous_time, comparison_hours=hours)
    required = ('temperature_c', 'dewpoint_c', 'u_ms', 'v_ms')
    if any(grids.get(k) is None or previous_grids.get(k) is None for k in required):
        status['temporal_status'] = 'Missing temperature/moisture/wind fields in one analysis'
        return current
    first = grids['temperature_c']; x, y = first[0][:-1], first[1]
    for key in required:
        if not (np.array_equal(grids[key][0], previous_grids[key][0]) and np.array_equal(grids[key][1], previous_grids[key][1])):
            status['temporal_status'] = 'Incompatible grids; no temporal classification'
            return current
    def arrays(source):
        return {k: np.asarray(source[k][2].filled(np.nan))[:, :-1] for k in required}
    now, old = arrays(grids), arrays(previous_grids)
    valid = np.ones(now['temperature_c'].shape, bool)
    for key in required:
        current_support, _, _ = support(rows, key, x, y)
        old_support, _, _ = support(previous_rows, key, x, y)
        valid &= current_support & old_support & np.isfinite(now[key]) & np.isfinite(old[key])
    valid = binary_erosion(valid, iterations=2)
    # Derivatives cannot cross missing-analysis boundaries.
    tx, ty = gradients(np.nan_to_num(now['temperature_c']), x, y)
    dx, dy = gradients(np.nan_to_num(now['dewpoint_c']), x, y)
    def cell(point):
        lon = (point[0]+180) % 360-180
        return int(np.argmin(abs(y-point[1]))), int(np.argmin(abs(x-lon)))
    def sample(field, point, source=now):
        a, b = cell(point)
        return float(source[field][a, b]) if valid[a,b] else None
    previous_fronts = [f for f in previous.get('features', []) if f['properties']['feature_type'] == 'front']
    used = set()
    for front in sorted(fronts, key=lambda f: -f['properties'].get('length_km', 0)):
        line = front['geometry']['coordinates']; mid = line[len(line)//2]; a,b = cell(mid)
        p = front['properties']
        p.update(previous_time=previous_time, comparison_hours=hours)
        if not valid[a,b]:
            p['evidence'].append('Insufficient common temporal observation support')
            continue
        magnitude = math.hypot(tx[a,b], ty[a,b])
        if magnitude < 1e-5: continue
        nx, ny = tx[a,b]/magnitude, ty[a,b]/magnitude
        options = []
        for index, candidate in enumerate(previous_fronts):
            if index in used: continue
            match = nearest_on_line(mid, candidate['geometry']['coordinates'])
            if match is None or match[0] > min(650, hours*70): continue
            # Avoid matching crossing/near-perpendicular boundaries.
            tangent = match[2]/max(np.linalg.norm(match[2]), 1e-9)
            if abs(tangent[0]*nx+tangent[1]*ny) > .5: continue
            options.append((match[0], index, match[1]))
        options.sort()
        if not options or (len(options)>1 and options[1][0]-options[0][0] < 50):
            p['evidence'].append('Previous boundary missing or ambiguous')
            continue
        distance, index, prior = options[0]; used.add(index)
        previous_t = sample('temperature_c', prior, old); current_t = sample('temperature_c', prior)
        if previous_t is None or current_t is None: continue
        east = ((mid[0]-prior[0]+180)%360-180)*111.195*math.cos(math.radians(mid[1]))
        north = (mid[1]-prior[1])*111.195
        speed = (east*nx+north*ny)/hours/1.852
        flow = (now['u_ms'][a,b]*nx+now['v_ms'][a,b]*ny)*1.94384449
        contrast = magnitude*200000
        type_ = classify_front(speed, flow, current_t-previous_t, contrast)
        p.update(front_type=type_, label=(type_.capitalize()+' front candidate') if type_!='unclassified' else 'Unclassified front candidate',
                 normal_motion_kt=round(speed,1), normal_flow_kt=round(flow,1), temperature_change_c=round(current_t-previous_t,1),
                 normal_to_warm_deg=round(math.degrees(math.atan2(nx,ny))%360))
        p['evidence'] += [f'Matched boundary {distance:.0f} km away, {hours:g} hours earlier',
                          f'Normal motion toward warmer air: {speed:.1f} kt; normal wind: {flow:.1f} kt',
                          f'Temperature change at prior boundary: {current_t-previous_t:+.1f} °C',
                          'Heuristic classification; 12-hour data can alias frontal development and daily heating']
        # Occlusion is NOT inferred merely because a front is near a low.
        nearby_types = {f['properties'].get('front_type') for f in previous_fronts
                         if (match := nearest_on_line(mid, f['geometry']['coordinates'])) and match[0] <= 300}
        near_low = any(distance_km(mid,f['geometry']['coordinates'])<=400 for f in current['features']
                       if f['properties']['feature_type']=='low')
        def offset(sign): return [mid[0]+sign*100*nx/(111.195*max(.2,math.cos(math.radians(mid[1])))),mid[1]+sign*100*ny/111.195]
        sides=[sample('temperature_c',offset(sign)) for sign in (-1,1)]
        core=sample('temperature_c',mid)
        cool_both = core is not None and all(v is not None and v<=core-2 for v in sides)
        elevated=[]
        for sign in (-1,0,1):
            pt=offset(sign)
            reports=[r['temperature_c'] for r in upper_rows or [] if r.get('level_hpa')==850 and r.get('temperature_c') is not None
                     and distance_km(pt,[r['longitude'],r['latitude']])<=150]
            elevated.append(float(np.mean(reports)) if len(reports)>=3 else None)
        warm_aloft = all(v is not None for v in elevated) and elevated[1]>=max(elevated[0],elevated[2])+2
        if occlusion_supported(nearby_types, near_low, cool_both, warm_aloft):
            p.update(front_type='occluded', label='Occluded front candidate')
            p['evidence'].append('Prior cold/warm arms near low; warm tongue aloft between cooler surface sides')
    # Sparse arrows visualize diagnosed advection, NOT traced parcel trajectories.
    advection=-(now['u_ms']*tx+now['v_ms']*ty)*86400
    moisture=-(now['u_ms']*dx+now['v_ms']*dy)*86400
    added=0
    for a in range(4,len(y)-4,8):
      for b in range(0,len(x),8):
        if not valid[a,b] or (abs(advection[a,b])<2 and abs(moisture[a,b])<2): continue
        u,v=now['u_ms'][a,b],now['v_ms'][a,b]; speed=math.hypot(u,v)
        if speed<2 or speed>50: continue
        # Two-hour wind-guided indicator, capped at 150 km, independent of snapshot gap.
        length=min(150,speed*7.2); cosine=max(.2,math.cos(math.radians(y[a])))
        end=[x[b]+length*u/speed/(111.195*cosine),y[a]+length*v/speed/111.195]
        warming=advection[a,b]>=0
        current['features'].append({'type':'Feature','geometry':{'type':'LineString','coordinates':[[float(x[b]),float(y[a])],end]},
          'properties':{'feature_type':'airmass','label':('Warm' if warming else 'Cold')+' advection · '+('moistening' if moisture[a,b]>=0 else 'drying'),
            'experimental':True,'confidence':'limited','observation_count':None,'nearest_observation_km':None,
            'previous_time':previous_time,'comparison_hours':hours,'warming':bool(warming),
            'wind_to_deg':round(math.degrees(math.atan2(u,v))%360),
            'temperature_advection_c_day':round(float(advection[a,b]),1),'dewpoint_advection_c_day':round(float(moisture[a,b]),1),
            'temperature_change_c':round(float(now['temperature_c'][a,b]-old['temperature_c'][a,b]),1),
            'dewpoint_change_c':round(float(now['dewpoint_c'][a,b]-old['dewpoint_c'][a,b]),1),
            'evidence':[f'Comparison interval: {hours:g} hours',f'Thermal advection: {advection[a,b]:+.1f} °C/day; moisture advection: {moisture[a,b]:+.1f} °C/day',
              f'Observed-analysis changes: T {now["temperature_c"][a,b]-old["temperature_c"][a,b]:+.1f} °C, Td {now["dewpoint_c"][a,b]-old["dewpoint_c"][a,b]:+.1f} °C',
              'Wind-guided advection indicator, not a tracked parcel or named source air mass; heating/mixing may oppose advection']}})
        added+=1
        if added>=150: break
      if added>=150: break
    status.update(temporal_status=f'Temporal comparison {hours:g} hours; experimental classifications and advection',feature_count=len(current['features']))
    return current
