import { AbstractLayer } from './AbstractLayer.js';
import { PixiFeaturePoint } from './PixiFeaturePoint.js';
import * as PIXI from 'pixi.js';

/**
 * PixiLayerOsmose
 * @class
 */
export class PixiLayerTest extends AbstractLayer {

  /**
   * @constructor
   * @param  scene    The Scene that owns this Layer
   * @param  layerID  Unique string to use for the name of this Layer
   */
  constructor(scene, layerID) {
    super(scene, layerID);
    this.enabled = true;
  }


  /**
   * supported
   * Whether the Layer's service exists
   */
  get supported() {
    return true;
  }


  /**
   * enabled
   * Whether the user has chosen to see the Layer
   * Make sure to start the service first.
   */
  get enabled() {
    return this._enabled;
  }
  set enabled(val) {
    if (!this.supported) {
      val = false;
    }

    if (val === this._enabled) return;  // no change
    this._enabled = val;
  }


  /**
   * reset
   * Every Layer should have a reset function to replace any Pixi objects and internal state.
   */
  reset() {
    super.reset();
  }


  /**
   * renderMarkers
   * @param  frame      Integer frame being rendered
   * @param  viewport   Pixi viewport to use for rendering
   * @param  zoom       Effective zoom to use for rendering
   */
  renderMarkers(frame, viewport, zoom) {
    const parentContainer = this.scene.groups.get('qa'); // 随便

    for (const d of [
      {
        id: -1,
        loc: [-73.9976413, 40.7208288],
      }
    ]) {
      const featureID = `${this.layerID}-${d.id}`;
      let feature = this.features.get(featureID);

      if (!feature) {
        const style = {
          markerName: 'test-marker',
          markerTint: '#000000',
          iconName: 'fas-question',
          iconSize: 32,
          iconTint: 0x05cb63
        };

        feature = new PixiFeaturePoint(this, featureID);
        feature.geometry.setCoords(d.loc);
        feature.style = style;
        feature.parentContainer = parentContainer;
        feature.setData(d.id, d);
      }

      this.syncFeatureClasses(feature);
      feature.update(viewport, zoom);
      this.retainFeature(feature, frame);
    }
  }

  // SMQ, try raw render, 跳出框架去渲染
  // http://localhost:8080/#map=19.97/40.72082/-73.99752&background=Bing&disable_features=points,service_roads,paths,buildings,building_parts,indoor,landuse,boundaries,water,rail,pistes,aerialways,power,past_future,others
  _g = null;
  renderRaw(frame, viewport, zoom) {
    const parentContainer = this.scene.groups.get('qa'); // 随便

    const loc = [-73.9976413, 40.7208288];
    const [x, y] = viewport.project(loc);

    if (this._g) {
      const g = this._g;
      g.clear();
      g.circle(x, y, 10);
      g.fill(0xde3249);
      return;
    }

    if (!this._g) {
      const g = new PIXI.Graphics();
      g.label = 'test-rect';

      g.clear();
      g.circle(x, y, 10);
      g.fill(0xde3249);
      parentContainer.addChild(g);
      this._g = g;
    }
  }

  /**
   * render
   * Render any data we have, and schedule fetching more of it to cover the view
   * @param  frame      Integer frame being rendered
   * @param  viewport   Pixi viewport to use for rendering
   * @param  zoom       Effective zoom to use for rendering
   */
  render(frame, viewport, zoom) {
    this.renderMarkers(frame, viewport, zoom);
    this.renderRaw(frame, viewport, zoom);
  }

}
