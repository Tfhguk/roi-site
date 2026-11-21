"""Metric height field sampled using the same coordinates as the route planner."""
import math
import numpy as np
from io import BytesIO
from PIL import Image


class Terrain:
    def __init__(self, scene):
        self.scale=scene['config']['metresPerUnit']
        self.map=scene['source']['elevation']
        self.values=np.array(self.map['cells']).reshape(self.map['rows'],self.map['cols'])
        self.width,self.length=1000*self.scale,700*self.scale
        self.minimum,self.maximum=float(self.values.min()),float(self.values.max())

    def height(self,x,y):
        u=max(0.,min(self.map['cols']-1,x/self.width*(self.map['cols']-1)))
        v=max(0.,min(self.map['rows']-1,y/self.length*(self.map['rows']-1)))
        c,r=min(self.map['cols']-2,int(u)),min(self.map['rows']-2,int(v))
        a,b=u-c,v-r
        return float((1-b)*((1-a)*self.values[r,c]+a*self.values[r,c+1])+b*((1-a)*self.values[r+1,c]+a*self.values[r+1,c+1]))

    def gradient(self,x,y):
        e=.02
        return ((self.height(x+e,y)-self.height(x-e,y))/(2*e),(self.height(x,y+e)-self.height(x,y-e))/(2*e))

    def slope(self,x,y,yaw):
        dx,dy=self.gradient(x,y)
        return math.atan(dx*math.cos(yaw)+dy*math.sin(yaw))

    def assets(self):
        v=(self.values-self.minimum)/max(.001,self.maximum-self.minimum)
        rgb=np.stack([.12+.45*v,.58-.15*v,.38-.2*v],axis=-1)
        output=BytesIO()
        Image.fromarray(np.uint8(np.flipud(rgb)*255)).save(output,format='PNG')
        return {'elevation.png':output.getvalue()}
