"""Metric-aware scalar/vector derivatives on regular longitude/latitude grids."""
import numpy as np

RADIUS_M = 6371000.


def gradients(z, x, y):
    z=np.asarray(z,dtype=float)
    latitude=np.radians(y)
    cosine=np.cos(latitude)
    # Callers mask polar caps. Do not silently clamp the map scale to cos=.2.
    cosine=np.where(abs(cosine)>1e-6,cosine,np.nan)
    dlon=np.radians(x[1]-x[0]);dlat=np.radians(y[1]-y[0])
    periodic=len(x)*abs(x[1]-x[0])>=359.9
    east=(np.roll(z,-1,axis=1)-np.roll(z,1,axis=1))/(2*dlon) if periodic else np.gradient(z,dlon,axis=1)
    return east/(RADIUS_M*cosine[:,None]),np.gradient(z,dlat,axis=0)/RADIUS_M


def vector_diagnostics(u,v,x,y,theta=None):
    ux,uy=gradients(u,x,y);vx,vy=gradients(v,x,y)
    metric=np.tan(np.radians(y))[:,None]/RADIUS_M
    # Covariant derivatives in the local east/north orthonormal frame.
    ux=ux-v*metric;vx=vx+u*metric
    result=dict(ux=ux,uy=uy,vx=vx,vy=vy,vorticity=vx-uy,
                divergence=ux+vy,deformation=np.hypot(ux-vy,uy+vx))
    if theta is not None:
        tx,ty=gradients(theta,x,y);g=np.hypot(tx,ty)
        result['frontogenesis_k_100km_3h']=np.where(g>1e-8,
            -(tx*tx*ux+tx*ty*(uy+vx)+ty*ty*vy)/np.maximum(g,1e-8)*1.08e9,0.)
    return result
