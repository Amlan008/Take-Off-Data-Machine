"""Observation-supported thermodynamic regions, not source-air-mass labels."""
import math
import numpy as np
import contourpy
from scipy.ndimage import label, binary_erosion, find_objects


def thermodynamics(temperature_c, dewpoint_c, pressure_hpa):
    if any(v is None or not math.isfinite(v) for v in (temperature_c, dewpoint_c, pressure_hpa)):
        return None
    if not (-100 < dewpoint_c <= temperature_c+.5 < 61 and 500 <= pressure_hpa <= 1100):
        return None
    t, td = temperature_c+273.15, dewpoint_c+273.15
    e=6.112*math.exp(17.67*dewpoint_c/(dewpoint_c+243.5))
    if e >= pressure_hpa: return None
    r=.622*e/(pressure_hpa-e)
    tlcl=1/(1/(td-56)+math.log(t/td)/800)+56
    theta=t*(1000/pressure_hpa)**.2854
    theta_e=t*(1000/(pressure_hpa-e))**(.2854*(1-.28*r))*math.exp((3376/tlcl-2.54)*r*(1+.81*r))
    return dict(theta_k=theta,theta_e_k=theta_e,mixing_ratio_gkg=r*1000)


def prepare_thermodynamics(rows):
    for row in rows:
        p=row.get('station_pressure_hpa') or row.get('station_pressure_estimate_hpa') or row.get('level_hpa')
        method='reported_or_estimated_station_pressure'
        # QNH/MSLP is NOT used as pressure at an elevated sensor. Where needed,
        # estimate station pressure hypsometrically, only for low terrain.
        if p is None and row.get('mslp_hpa') is not None and row.get('temperature_c') is not None and row.get('elevation_m') is not None and -500 <= row['elevation_m'] <= 800:
            p=row['mslp_hpa']*math.exp(-9.80665*row['elevation_m']/(287.05*(row['temperature_c']+273.15+.00325*row['elevation_m'])))
            method='approximate_station_pressure_from_mslp_temperature_elevation'
        values=thermodynamics(row.get('temperature_c'),row.get('dewpoint_c'),p)
        for key in ('theta_k','theta_e_k','mixing_ratio_gkg'): row[key]=values[key] if values else None
        t=row.get('temperature_c')
        if t is not None and p is not None and math.isfinite(t) and math.isfinite(p) and -100<t<60 and 500<=p<=1100:
            row['theta_k']=(t+273.15)*(1000/p)**.2854
        row['thermodynamic_pressure_method']=method if row['theta_k'] is not None else 'unavailable'
    return rows


def region_polygons(mask,x,y,properties,minimum_cells=12):
    """Connected supported patches. Unsupported cells stay masked, including holes.

    No smoothing across holes or longitude seams. Edge-truncated polygons are
    approximate regional extents, not sharp meteorological boundaries.
    """
    features=[]
    components,count=label(mask)
    for component,bounds in enumerate(find_objects(components),1):
        if bounds is None:continue
        a,b=bounds
        a=slice(max(0,a.start-1),min(len(y),a.stop+1));b=slice(max(0,b.start-1),min(len(x),b.stop+1))
        part=components[a,b]==component
        if part.sum()<minimum_cells: continue
        if min(part.shape)<2:continue
        generator=contourpy.contour_generator(x=x[b],y=y[a],z=np.ma.array(part.astype(float),mask=~mask[a,b]),fill_type='OuterOffset',corner_mask=False)
        polygons,offsets=generator.filled(.5,1.5)
        for polygon,rings in zip(polygons,offsets):
            coords=[np.round(polygon[start:end],4).tolist() for start,end in zip(rings[:-1],rings[1:])]
            if not coords or len(coords[0])<4: continue
            features.append({'type':'Feature','geometry':{'type':'Polygon','coordinates':coords},
                'properties':dict(properties,grid_cell_count=int(part.sum()),experimental=True,confidence='limited',
                  evidence=list(properties.get('evidence',[]))+['Approximate connected supported area; blank cells and holes are not filled','Not a tracked parcel or named continental/maritime source air mass'])})
    return features


def air_mass_regions(rows,grids,valid_time):
    from synoptic_features import support
    fields=('theta_k','theta_e_k','mixing_ratio_gkg')
    if any(grids.get(key) is None for key in fields): return []
    first=grids[fields[0]]; x,y=first[0][:-1],first[1]
    data={key:np.asarray(grids[key][2].filled(np.nan))[:,:-1] for key in fields}
    valid=np.ones(data[fields[0]].shape,bool)
    for key in fields:
        coverage,_,_=support(rows,key,x,y)
        valid &= coverage & np.isfinite(data[key])
    valid=binary_erosion(valid,iterations=1)
    # Fixed physical bins, not changing viewport percentiles. Adjacent bins may
    # belong to the same air mass; labels intentionally avoid source attribution.
    theta=data['theta_k']; moisture=data['mixing_ratio_gkg']; features=[]
    for low,high,name in ((0,285,'Cold'),(285,300,'Cool'),(300,315,'Warm'),(315,500,'Hot')):
        for dry,label_,label_text in ((True,'dry','drier'),(False,'moist','moister')):
            mask=valid&(theta>=low)&(theta<high)&((moisture<6) if dry else (moisture>=6))
            props={'feature_type':'airmass_region','label':name+' / '+label_text+' thermodynamic region',
                   'thermal_class':name.lower(),'moisture_class':label_,'level_reference':'surface potential temperature',
                   'valid_time':valid_time,'theta_range_k':[low if low else None,high if high<500 else None],
                   'evidence':['Surface potential-temperature bins: <285 / 285–300 / 300–315 / ≥315 K',
                      'Mixing-ratio split: 6 g/kg; not a universal air-mass definition',
                      'Potential/equivalent-potential temperature use reported or explicitly approximate station pressure']}
            features.extend(region_polygons(mask,x,y,props))
    return features
