import { selection } from 'd3-selection';
import {
  DEG2RAD, RAD2DEG, TAU, Extent, Viewport, geoMetersToLon, geoZoomToScale,
  numClamp, numWrap, vecAdd, vecRotate, vecSubtract, vecEqual
} from '@rapid-sdk/math';

import { AbstractSystem } from './AbstractSystem.js';
import { QAItem } from '../osm/index.js';
import { utilTotalExtent } from '../util/index.js';
import { Application, Graphics, Container} from 'pixi.js';

const TILESIZE = 256;
const MIN_Z = 2;
const MAX_Z = 24;


/**
 * `MapSystem` maintains the map state and provides an interface for manipulating the map view.
 *
 * Properties available:
 *   `highlightEdits`  `true` if edited features should be shown in a special style, `false` otherwise
 *   `areaFillMode`    one of 'full', 'partial' (default), or 'wireframe'
 *   `wireframeMode`   `true` if fill mode is 'wireframe', `false` otherwise
 *
 * Events available:
 *   `draw`       Fires after a full redraw
 *   `move`       Fires after the map's transform has changed (can fire frequently)
 *                 ('move' is mostly for when you want to update some content that floats over the map)
 *   `mapchange`  Fires on any change in map display options (wireframe/areafill, highlightedits)
 */
export class MapSystem extends AbstractSystem {

  /**
   * @constructor
   * @param  `context`   Global shared application context
   */
  constructor(context) {
    super(context);
    this.id = 'map';
    this.dependencies = new Set(['editor', 'filters', 'gfx', 'imagery', 'l10n', 'photos', 'rapid', 'storage', 'styles', 'urlhash']);

    // display options
    this.areaFillOptions = ['wireframe', 'partial', 'full'];
    this._highlightEdits = false;      // whether to style edited features differently
    this._currFillMode = 'partial';    // the current fill mode
    this._toggleFillMode = 'partial';  // the previous *non-wireframe* fill mode

    this._initPromise = null;
    this._startPromise = null;
    this._keys = null;

    // D3 selections
    this.$parent = null;

    // Ensure methods used as callbacks always have `this` bound correctly.
    // (This is also necessary when using `d3-selection.call`)
    this._hashchange = this._hashchange.bind(this);
    this._updateHash = this._updateHash.bind(this);
    this._setupKeybinding = this._setupKeybinding.bind(this);
    this.render = this.render.bind(this);
    this.immediateRedraw = this.immediateRedraw.bind(this);
    this.deferredRedraw = this.deferredRedraw.bind(this);

    this._customApp = new Application();
    const _customApp = this._customApp;
    const _circle = new Graphics();
    const container = new Container();
    this._container = container;
    // container.addChild(_circle);
    // _customApp.stage.addChild(container);

    // _circle.circle(0, 0, 10);
    // _circle.fill(0xde3249, 1);
  }

  testDraw(x, y) {
    // const gfx = this.context.systems.gfx;
    // const _customApp = this._customApp;
    // this._container.position.set(x, y);

    // const pixiDims = gfx._pixiViewport.dimensions;
    // const canvasDims = [_customApp.screen.width, _customApp.screen.height];
    // if (!vecEqual(pixiDims, canvasDims)) {
    //   const [w, h] = pixiDims;
    //   const renderer = _customApp.renderer;
    //   renderer.resize(w, h);
    // }
    // context.systems.gfx.pixi.renderer.gl.finish();
    // _customApp.render();
    // _customApp.renderer.gl.finish();
  }


  /**
   * initAsync
   * Called after all core objects have been constructed.
   * @return {Promise} Promise resolved when this component has completed initialization
   */
  initAsync() {
    if (this._initPromise) return this._initPromise;

    for (const id of this.dependencies) {
      if (!this.context.systems[id]) {
        return Promise.reject(`Cannot init:  ${this.id} requires ${id}`);
      }
    }

    const context = this.context;
    const editor = context.systems.editor;
    const filters = context.systems.filters;
    const gfx = context.systems.gfx;
    const imagery = context.systems.imagery;
    const l10n = context.systems.l10n;
    const photos = context.systems.photos;
    const rapid = context.systems.rapid;
    const storage = context.systems.storage;
    const styles = context.systems.styles;
    const urlhash = context.systems.urlhash;

    // Note: We want MapSystem's hashchange listener registered as early as possible
    // because so many other parts of Rapid rely on the map location being set correctly.
    // Other systems should register their hashchange listener after MapSystem.initAsync.
    urlhash.on('hashchange', this._hashchange);

    const prerequisites = Promise.all([
      gfx.initAsync(),
      l10n.initAsync(),
      storage.initAsync(),
    ]);

    return this._initPromise = prerequisites
      .then(() => {
        this._currFillMode = storage.getItem('area-fill') || 'partial';           // the current fill mode
        this._toggleFillMode = storage.getItem('area-fill-toggle') || 'partial';  // the previous *non-wireframe* fill mode

        // Scene will exist after gfx init
        const scene = gfx.scene;

        // Setup Event Handlers..
        // Forward the 'move' and 'draw' events from the GraphicsSystem
        gfx
          .on('move', () => this.emit('move'))
          .on('draw', () => {
            this._updateHash();
            this.emit('draw', { full: true });  // pass {full: true} for legacy receivers

            // SMQ, 在这里用pixijs在新加坡画一个圆儿，验证渲染是否能同步
            // this.testDraw();
          });

        editor
          .on('merge', entityIDs => {
            if (entityIDs) {
              scene.dirtyData('osm', entityIDs);
            }
            gfx.deferredRedraw();
          })
          .on('stagingchange', difference => {
            // todo - maybe only do this if difference.didChange.geometry?
            const complete = difference.complete();
            for (const entity of complete.values()) {
              if (entity) {      // may be undefined if entity was deleted
                entity.touch();  // bump .v in place, rendering code will pick it up as dirty
                filters.clearEntity(entity);  // clear feature filter cache
              }
            }
            gfx.immediateRedraw();
          })
          .on('historyjump', (prevIndex, currIndex) => {
            // This code occurs when jumping to a different edit because of a undo/redo/restore, etc.
            const prevEdit = editor.history[prevIndex];
            const currEdit = editor.history[currIndex];

            // Counterintuitively, when undoing, we might want the metadata from the _next_ edit (located at prevIndex).
            // If that edit exists (it might not if we are restoring) use that one, otherwise just use the current edit
            const didUndo = (currIndex === prevIndex - 1);
            const edit = (didUndo && prevEdit) ?? currEdit;

            // Reposition the map if we've jumped to a different place.
            const t0 = context.viewport.transform.props;
            const t1 = edit.transform;
            if (t1 && (t0.x !== t1.x || t0.y !== t1.y || t0.k !== t1.k || t0.r !== t1.r)) {
              this.transformEase(t1);
            }

            // Switch to select mode if the edit contains selected ids.
            // Note: draw modes need to do a little extra work to survive this,
            //  so they have their own `historyjump` listeners.
            const modeID = context.mode?.id;
            if (/^draw/.test(modeID)) return;

            // For now these IDs are assumed to be OSM ids.
            // Check that they are actually in the stable graph.
            const graph = edit.graph;
            const checkIDs = edit.selectedIDs ?? [];
            const selectedIDs = checkIDs.filter(entityID => graph.hasEntity(entityID));
            if (selectedIDs.length) {
              context.enter('select-osm', { selection: { osm: selectedIDs }} );
            } else {
              context.enter('browse');
            }
          });

        filters
          .on('filterchange', () => {
            scene.dirtyLayers('osm');
            gfx.immediateRedraw();
          });

        rapid
          .on('datasetchange', () => {
            scene.dirtyLayers(['rapid', 'rapidoverlay']);
            gfx.immediateRedraw();
          });

        l10n
          .on('localechange', () => {
            this._setupKeybinding();
            scene.dirtyScene();    // labeled features can be on any layer
            gfx.immediateRedraw();
          });

        context.on('modechange', gfx.immediateRedraw);
        imagery.on('imagerychange', gfx.immediateRedraw);
        photos.on('photochange', gfx.immediateRedraw);
        scene.on('layerchange', gfx.immediateRedraw);
        styles.on('stylechange', gfx.immediateRedraw);

        const osm = context.services.osm;
        if (osm) {
          osm.on('authchange', gfx.immediateRedraw);
        }

        this._setupKeybinding();
      });
  }


  /**
   * startAsync
   * Called after all core objects have been initialized.
   * @return {Promise} Promise resolved when this component has completed startup
   */
  startAsync() {
    this._started = true;
    return Promise.resolve();
  }


  /**
   * resetAsync
   * Called after completing an edit session to reset any internal state
   * Note that calling `resetAsync` schedules an "immediate" redraw (on the next available tick).
   * @return {Promise} Promise resolved when this component has completed resetting
   */
  resetAsync() {
    return Promise.resolve();
  }


  /**
   * render
   * Accepts a parent selection, and renders the content under it.
   * (The parent selection is required the first time, but can be inferred on subsequent renders)
   * @param {d3-selection} $parent - A d3-selection to a HTMLElement that this component should render itself into
   */
  render($parent = this.$parent) {
    if ($parent instanceof selection) {
      this.$parent = $parent;
    } else {
      return;   // no parent - called too early?
    }

    const context = this.context;
    const gfx = context.systems.gfx;

    // Everything in here runs one time (on enter).
    // The 'main-map' is an absolutely positioned container that fills the space where the map will go.
    const $$mainmap = $parent.selectAll('.main-map')
      .data([0])
      .enter()
      .append('div')
      .attr('class', 'main-map')
      // Suppress the native right-click context menu
      .on('contextmenu', e => e.preventDefault())
      // Suppress swipe-to-navigate browser pages on trackpad/magic mouse – iD#5552
      .on('wheel.map mousewheel.map', e => e.preventDefault());

    // The `supersurface` is a wrapper div that we temporarily transform as the user zooms and pans.
    // This allows us to defer actual rendering until the browser has more time to do it.
    // At regular intervals we reset this root transform and actually redraw the map.
    const $$supersurface = $$mainmap
      .append(() => gfx.supersurface)
      .attr('class', 'supersurface');

    // Content beneath the supersurface may be transformed and will need to rerender sometimes.
    // This includes the Pixi WebGL canvas and the right-click edit menu

    // Historically `surface` was the root of the SVG DOM - Now it's the Pixi WebGL canvas.
    // Things that will not work anymore:
    //  - d3 selecting surface's child stuff
    //  - css classing surface's child stuff
    //  - listening to events on the surface
    $$supersurface
      .append(() => gfx.surface)
      .attr('class', 'surface');

    // The `overlay` is a div that is transformed to cancel out the supersurface.
    // This is a place to put things _not drawn by pixi_ that should stay positioned
    // with the map, like the editmenu.
    $$supersurface
      .append(() => gfx.overlay)
      .attr('class', 'overlay');

    // const urlhash = context.systems.urlhash;
    // let renderPreference = 'webgl';
    // let renderGLVersion = 2;
    // switch (urlhash.initialHashParams.get('renderer')) {
    //   case 'webgpu':
    //     renderPreference = 'webgpu';
    //     break;
    //   case 'webgl1':
    //     renderGLVersion = 1;
    //     break;
    // }

    // gfx.initAsync().then(async () => {
    //   const $supersurface = gfx.supersurface;
    //   const $rapidsurface = gfx.surface;
    //   const highQuality = true;
    //   // const device = gfx.pixi_device;
    //   await this._customApp.init({
    //     // device,
    //     antialias: highQuality,
    //     autoDensity: highQuality,
    //     autoStart: false,     // Avoid the ticker
    //     events: {
    //       move: false,
    //       globalMove: false,
    //       click: true,
    //       wheel: false
    //     },
    //     // multiView: true,   // Needed for minimap
    //     powerPreference: 'high-performance',
    //     preference: renderPreference,
    //     preferWebGLVersion: renderGLVersion,
    //     preserveDrawingBuffer: true,
    //     resolution: highQuality ? window.devicePixelRatio : 1,
    //     sharedLoader: true,
    //     sharedTicker: false,  // Avoid the ticker
    //     textureGCActive: true,
    //     useBackBuffer: false,
    //     backgroundAlpha: 0,
    //   });
    //   const $customsurface = this._customApp.canvas;

    //   console.log('dom dependencies', this._customApp, $supersurface, $rapidsurface, $customsurface);
    //   $rapidsurface.insertAdjacentElement('afterend', $customsurface);
    // });
  }


  /**
   * _setupKeybinding
   * This sets up the keybinding, replacing existing if needed
   */
  _setupKeybinding() {
    const context = this.context;
    const keybinding = context.keybinding();
    const l10n = context.systems.l10n;

    if (Array.isArray(this._keys)) {
      keybinding.off(this._keys);
    }

    const wireframeKey = l10n.t('shortcuts.command.wireframe.key');
    const highlightEditsKey = l10n.t('shortcuts.command.highlight_edits.key');
    this._keys = [wireframeKey, highlightEditsKey];

    context.keybinding()
      .on(wireframeKey, e => {
        e.preventDefault();
        e.stopPropagation();
        this.wireframeMode = !this.wireframeMode;
      })
      .on(highlightEditsKey, e => {
        e.preventDefault();
        this.highlightEdits = !this.highlightEdits;
      });
  }


  /**
   * _hashchange
   * Respond to any changes appearing in the url hash
   * @param  currParams   Map(key -> value) of the current hash parameters
   * @param  prevParams   Map(key -> value) of the previous hash parameters
   */
  _hashchange(currParams, prevParams) {
    const context = this.context;
    const scene = context.systems.gfx.scene;

    // map
    const newMap = currParams.get('map');
    const oldMap = prevParams.get('map');
    if (!newMap || newMap !== oldMap) {
      let zoom, lat, lon, ang;
      if (typeof newMap === 'string') {
        [zoom, lat, lon, ang] = newMap.split('/', 4).map(Number);
      }
      if (isNaN(zoom) || !isFinite(zoom)) zoom = 2;
      if (isNaN(lat) || !isFinite(lat)) lat = 0;
      if (isNaN(lon) || !isFinite(lon)) lon = 0;
      if (isNaN(ang) || !isFinite(ang)) ang = 0;

      zoom = numClamp(zoom, MIN_Z, MAX_Z);
      lat = numClamp(lat, -90, 90);
      lon = numClamp(lon, -180, 180);
      // Why a '-' here?  Because "bearing" is the angle that the user points, not the angle that north points.
      ang = numWrap(-ang, 0, 360);

      this.setMapParams([lon, lat], zoom, ang * DEG2RAD);   // will eventually call setTransformAsync
    }

    // id
    const newIds = currParams.get('id');
    const oldIds = prevParams.get('id');
    if (newIds !== oldIds) {
      if (typeof newIds === 'string') {
        const ids = newIds.split(',').map(s => s.trim()).filter(Boolean);
        const modeID = this.mode?.id;
        if (ids.length && modeID !== 'save') {
          this.selectEntityID(ids[0]);  // for now, just the select first one
        }
      }
    }

    // note
    // Support opening notes layer with a URL parameter:
    //  e.g. `note=true`  -or-
    //  e.g. `note=<noteID>`
    const newNote = currParams.get('note') || '';
    const oldNote = prevParams.get('note') || '';
    if (newNote !== oldNote) {
      let isEnabled = false;
      let noteID = null;

      const vals = newNote.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      for (const val of vals) {
        if (val === 'true') {
          isEnabled = true;
          continue;
        }
        // Try the value as a number, but reject things like NaN, null, Infinity
        const num = +val;
        const valIsNumber = (!isNaN(num) && isFinite(num));
        if (valIsNumber) {
          isEnabled = true;
          noteID = num;  // for now, just select the first one
          break;
        }
      }

      if (noteID) {
        this.selectNoteID(noteID);
      } else if (isEnabled) {
        scene.enableLayers('notes');
      } else {
        scene.disableLayers('notes');
      }
    }
  }


  /**
   * _updateHash
   * Push changes in map state to the urlhash.
   * This gets called on 'draw', so fairly frequently
   */
  _updateHash() {
    const context = this.context;
    const scene = context.systems.gfx.scene;
    const urlhash = context.systems.urlhash;
    const viewport = context.viewport;

    // map
    const [lon, lat] = viewport.centerLoc();
    const transform = viewport.transform;
    const zoom = transform.zoom;
    // Why a '-' here?  Because "bearing" is the angle that the user points, not the angle that north points.
    const ang = numWrap(-transform.r * RAD2DEG, 0, 360);
    const precision = Math.max(0, Math.ceil(Math.log(zoom) / Math.LN2));
    const EPSILON = 0.1;

    const zoomStr = zoom.toFixed(2);
    const latStr = lat.toFixed(precision);
    const lonStr = lon.toFixed(precision);
    const angStr = ang.toFixed(1);  // degrees

    let val = `${zoomStr}/${latStr}/${lonStr}`;
    if (Math.abs(ang) > EPSILON) {
      val += `/${angStr}`;
    }

    urlhash.setParam('map', val);


    // note
    const layer = scene.layers.get('notes');
    let noteID;
    const [pair] = context.selectedData();  // get the first thing in the Map()
    const [datumID, datum] = pair || [];
    if (datum instanceof QAItem && datum.service === 'osm') {
      noteID = datumID;
    }

    // `note=true` -or- `note=<noteID>`
    if (layer?.enabled) {
      if (noteID) {
        urlhash.setParam('note', noteID);
      } else {
        urlhash.setParam('note', 'true');
      }
    } else {
      urlhash.setParam('note', null);
    }

  }


  /**
   * deferredRedraw
   * Tell the renderer to redraw soon
   * This is ideal for most situations where data is streaming in, and we can
   * allow the changes to batch up over several animation frames.
   */
  deferredRedraw() {
    const gfx = this.context.systems.gfx;
    gfx.deferredRedraw();
  }


  /**
   * immediateRedraw
   * Tell the renderer to redraw as soon as possible.
   * This is ideal for interactive situations where the user did a thing and we want
   * the map to update on one of the next few animation frames to show their change.
   */
  immediateRedraw() {
    const gfx = this.context.systems.gfx;
    gfx.immediateRedraw();
  }


  /**
   * centerPoint
   * Returns the [x,y] pixel at the center of the viewport
   * @return  Array [x,y] pixel at the center of the viewport
   */
  centerPoint() {
    return this.context.viewport.center();
  }


  /**
   * centerLoc
   * Returns the current [lon,lat] location at the center of the viewport
   * @return  Array [lon,lat] location at the center of the viewport
   */
  centerLoc() {
    return this.context.viewport.centerLoc();
  }


  /**
   * mouse
   * Gets the current [x,y] pixel location of the pointer
   * (or center of map if there is no readily available pointer coordinate)
   * @return  Array [x,y] pixel location of pointer (or center of the map)
   */
  mouse() {
    const gfx = this.context.systems.gfx;
    return gfx.events?.coord?.map || this.centerPoint();
  }


  /**
   * mouseLoc
   * Gets the current [lon,lat] location of the pointer
   * (or center of map if there is no readily available pointer coordinate)
   * @return  Array [lon,lat] location of pointer (or center of the map)
   */
  mouseLoc() {
    return this.context.viewport.unproject(this.mouse());
  }


  /**
   * transform
   * Set/Get the map transform
   * IF setting, will schedule an update of map transform.
   * All convenience methods for adjusting the map go through here.
   * @param  t2         Transform Object with `x`,`y`,`k`,`r` properties.
   * @param  duration?  Duration of the transition in milliseconds, defaults to 0ms (asap)
   * @return map transform -or- this
   */
  transform(t2, duration) {
    if (t2 === undefined) {
      return this.context.viewport.transform.props;
    }

    // Avoid tiny or out of bounds rotations
    t2.r = numWrap((+(t2.r || 0).toFixed(3)), 0, TAU);   // radians

    const gfx = this.context.systems.gfx;
    gfx.setTransformAsync(t2, duration ?? 0);
    return this;
  }


  /**
   * setTransformAsync
   * Newer Promise-returning version of `transform()`
   * @param   t2         Transform Object with `x`,`y`,`k`,`r` properties.
   * @param   duration?  Duration of the transition in milliseconds, defaults to 0ms (asap)
   * @return  Promise that resolves when the transform has finished changing
   */
  setTransformAsync(t2, duration = 0) {
    // Avoid tiny or out of bounds rotations
    t2.r = numWrap((+(t2.r || 0).toFixed(3)), 0, TAU);   // radians

    const gfx = this.context.systems.gfx;
    return gfx.setTransformAsync(t2, duration);
  }


  /**
   * setMapParams
   * Set loc, zoom, and rotation at the same time.
   * @param  loc2       Array [lon,lat] to set the center to
   * @param  z2         Number to set the zoom to
   * @param  r2         Number to set the rotation to (in radians)
   * @param  duration?  Duration of the transition in milliseconds, defaults to 0ms (asap)
   * @return this
   */
  setMapParams(loc2, z2, r2, duration = 0) {
    const context = this.context;
    const view1 = context.viewport;
    const center = view1.center();
    const loc1 = view1.centerLoc();
    const t1 = view1.transform;
    const z1 = t1.zoom;
    const r1 = t1.r;

    if (loc2 === undefined) loc2 = loc1;
    if (z2 === undefined)   z2 = z1;
    if (r2 === undefined)   r2 = r1;

    // Bounds and precision checks
    loc2[0] = numClamp(loc2[0] || 0, -180, 180);
    loc2[1] = numClamp(loc2[1] || 0, -90, 90);
    z2 = numClamp((+(z2 || 0).toFixed(2)), MIN_Z, MAX_Z);
    r2 = numWrap((+(r2 || 0).toFixed(3)), 0, TAU);  // radians

    if (loc2[0] === loc1[0] && loc2[1] === loc1[1] && z2 === z1 && r2 === r1) {  // nothing to do
      return this;
    }

    const k2 = geoZoomToScale(z2, TILESIZE);
    const view2 = new Viewport(t1, view1.dimensions);
    view2.transform.scale = k2;

    let xy = view2.transform.translation;
    const point = view2.project(loc2);
    const delta = vecSubtract(center, point);
    xy = vecAdd(xy, delta);

    return this.transform({ x: xy[0], y: xy[1], k: k2, r: r2 }, duration);
  }


  /**
   * setMapParamsAsync
   * Promise-returning version of `setMapParams()`
   * @param  loc2       Array [lon,lat] to set the center to
   * @param  z2         Number to set the zoom to
   * @param  r2         Number to set the rotation to (in radians)
   * @param  duration?  Duration of the transition in milliseconds, defaults to 0ms (asap)
   * @return Promise that resolves when the transform has finished changing
   */
  setMapParamsAsync(loc2, z2, r2, duration = 0) {
    const context = this.context;
    const view1 = context.viewport;
    const center = view1.center();
    const loc1 = view1.centerLoc();
    const t1 = view1.transform;
    const z1 = t1.zoom;
    const r1 = t1.r;

    if (loc2 === undefined) loc2 = loc1;
    if (z2 === undefined)   z2 = z1;
    if (r2 === undefined)   r2 = r1;

    // Bounds and precision checks
    loc2[0] = numClamp(loc2[0] || 0, -180, 180);
    loc2[1] = numClamp(loc2[1] || 0, -90, 90);
    z2 = numClamp((+(z2 || 0).toFixed(2)), MIN_Z, MAX_Z);
    r2 = numWrap((+(r2 || 0).toFixed(3)), 0, TAU);  // radians

    if (loc2[0] === loc1[0] && loc2[1] === loc1[1] && z2 === z1 && r2 === r1) {  // nothing to do
      return Promise.resolve(t1);
    }

    const k2 = geoZoomToScale(z2, TILESIZE);
    const view2 = new Viewport(t1, view1.dimensions);
    view2.transform.scale = k2;

    let xy = view2.transform.translation;
    const point = view2.project(loc2);
    const delta = vecSubtract(center, point);
    xy = vecAdd(xy, delta);

    return this.setTransformAsync({ x: xy[0], y: xy[1], k: k2, r: r2 }, duration);
  }


  /**
   * center
   * Set/Get the map center
   * @param  loc2?      Array [lon,lat] to set the center to
   * @param  duration?  Duration of the transition in milliseconds, defaults to 0ms (asap)
   * @return map center -or- this
   */
  center(loc2, duration) {
    if (loc2 === undefined) {
      return this.centerLoc();
    } else {
      return this.setMapParams(loc2, undefined, undefined, duration ?? 0);
    }
  }


  /**
   * zoom
   * Set/Get the map zoom
   * @param  z2?        Number to set the zoom to
   * @param  duration?  Duration of the transition in milliseconds, defaults to 0ms (asap)
   * @return map zoom -or- this
   */
  zoom(z2, duration) {
    if (z2 === undefined) {
      return this.context.viewport.transform.zoom;
    } else {
      return this.setMapParams(undefined, z2, undefined, duration ?? 0);
    }
  }


  /**
   * pan
   * Pan the map by given pixel amount
   * @param  delta      Array [dx,dy] amount to pan the map
   * @param  duration?  Duration of the transition in milliseconds, defaults to 0ms (asap)
   * @return this
   */
  pan(delta, duration = 0) {
    const t = this.context.viewport.transform;
    const [dx, dy] = vecRotate(delta, -t.r, [0, 0]);   // remove any rotation
    return this.transform({ x: t.x + dx, y: t.y + dy, k: t.k, r: t.r }, duration);
  }


  /**
   * fitEntities
   * Adjust the map to fit to see the given entity or entities
   * @param  entities   Entity or Array of entities to fit in the map view
   * @param  duration?  Duration of the transition in milliseconds, defaults to 0ms (asap)
   * @return this
   */
  fitEntities(entities, duration = 0) {
    let extent;

    const editor = this.context.systems.editor;
    const graph = editor.staging.graph;

    if (Array.isArray(entities)) {
      extent = utilTotalExtent(entities, graph);
    } else {
      extent = entities.extent(graph);
    }
    if (!isFinite(extent.area())) return this;

    const z2 = numClamp(this.trimmedExtentZoom(extent), 0, 20);
    return this.setMapParams(extent.center(), z2, undefined, duration);
  }


  /**
   * selectEntityID
   * Selects an entity by ID, loading it first if needed
   * @param  {string}  entityID  - entityID to select
   * @param  {boolean} fitEntity - Whether to force fit the map view to show the entity
   */
  selectEntityID(entityID, fitEntity = false) {
    const context = this.context;
    const editor = context.systems.editor;
    const scene = context.systems.gfx.scene;
    const viewport = context.viewport;

    if (!entityID) {
      context.enter('browse');
      return;
    }

    const gotEntity = (entity) => {
      const selectedIDs = context.selectedIDs();
      if (context.mode?.id !== 'select-osm' || !selectedIDs.includes(entityID)) {
        scene.enableLayers('osm');
        context.enter('select-osm', { selection: { osm: [entity.id] }} );
      }

      const currGraph = editor.staging.graph;  // may have changed by the time we get in here
      const entityExtent = entity.extent(currGraph);
      const entityZoom = Math.min(this.trimmedExtentZoom(entityExtent), 20);  // the zoom that best shows the entity
      const isOffscreen = (entityExtent.percentContainedIn(viewport.visibleExtent()) < 0.8);
      const isTooSmall = (viewport.transform.zoom < entityZoom - 2);

      // Can't reasonably see it, or we're forcing the fit.
      if (fitEntity || isOffscreen || isTooSmall) {
        this.fitEntities(entity);
      }
    };

    const currGraph = editor.staging.graph;
    let entity = currGraph.hasEntity(entityID);
    if (entity) {   // have it already
      gotEntity(entity);
    } else {   // need to load it first
      context.loadEntity(entityID, (err, result) => {
        if (err) return;
        entity = result.data.find(e => e.id === entityID);
        if (!entity) return;
        gotEntity(entity);
      });
    }
  }


  /**
   * selectNoteID
   * Selects a note by ID, loading it first if needed
   * @param  {string}   noteID  - noteID to select
   */
  selectNoteID(noteID) {
    const context = this.context;
    const osm = context.services.osm;
    const scene = context.systems.gfx.scene;

    if (!noteID || !osm) {
      context.enter('browse');
      return;
    }

    const gotNote = (note) => {
      scene.enableLayers('notes');
      const selection = new Map().set(note.id, note);
      context.enter('select', { selection: selection });
      this.centerZoomEase(note.loc, 19);
    };

    let note = osm.getNote(noteID);
    if (note) {
      gotNote(note);
    } else {   // need to load it first
      osm.loadNote(noteID, (err) => {
        if (err) return;
        note = osm.getNote(noteID);
        if (note) {
          gotNote(note);
        }
      });
    }
  }


  // convenience methods for zooming in and out
  _zoomIn(delta)  { return this.setMapParams(undefined, ~~this.zoom() + delta, undefined, 250); }
  _zoomOut(delta) { return this.setMapParams(undefined, ~~this.zoom() - delta, undefined, 250); }

  zoomIn()        { return this._zoomIn(1); }
  zoomInFurther() { return this._zoomIn(4); }
  canZoomIn()     { return this.zoom() < MAX_Z; }

  zoomOut()        { return this._zoomOut(1); }
  zoomOutFurther() { return this._zoomOut(4); }
  canZoomOut()     { return this.zoom() > MIN_Z; }

  centerZoom(loc2, z2, duration = 0)          { return this.setMapParams(loc2, z2, undefined, duration); }

  // convenience methods for the above, but with easing
  transformEase(t2, duration = 250)           { return this.transform(t2, duration); }
  centerZoomEase(loc2, z2, duration = 250)    { return this.setMapParams(loc2, z2, undefined, duration); }
  centerEase(loc2, duration = 250)            { return this.setMapParams(loc2, undefined, undefined, duration); }
  zoomEase(z2, duration = 250)                { return this.setMapParams(undefined, z2, undefined, duration); }
  fitEntitiesEase(entities, duration = 250)   { return this.fitEntities(entities, duration); }


  /**
   * effectiveZoom
   * The "effective" zoom can be more useful for controlling the experience of the user.
   * This zoom is adjusted by latitude.
   * You can think of it as "what the zoom would be if we were editing at the equator"
   * For example, if we are editing in Murmansk, Russia, at about 69° North latitude,
   *  a true zoom of 14.6 corresponds to an effective zoom of 16.
   * Put another way, even at z14.6 the user should be allowed to edit the map,
   *  and it should be styled as if it were z16.
   *
   * @return  effective zoom
   */
  effectiveZoom() {
    const viewport = this.context.viewport;
    const lat = viewport.centerLoc()[1];
    const z = viewport.transform.zoom;
    const atLatitude = geoMetersToLon(1, lat);
    const atEquator = geoMetersToLon(1, 0);
    const extraZoom = Math.log(atLatitude / atEquator) / Math.LN2;
    return Math.min(z + extraZoom, MAX_Z);
  }


  /**
   * extent
   * Set/Get the map extent
   * @param  extent?    Extent Object to fit the map to
   * @return map extent -or- this
   */
  extent(extent) {
    if (extent === undefined) {
      return this.context.viewport.visibleExtent();
    } else {
      return this.setMapParams(extent.center(), this.extentZoom(extent));
    }
  }


  /**
   * trimmedExtent
   * Set/Get the map extent, but include some padding for header, footer, etc.
   * @param  extent?    Extent Object to fit the map to
   * @return map extent -or- this
   */
  trimmedExtent(extent) {
    if (extent === undefined) {
      const headerY = 72;
      const footerY = 30;
// Add 50px overscan experiment, see UISystem.js
// Maybe find a nicer way to include overscan and view padding into places like this.
      // const pad = 10;
      const pad = 70;
      const viewport = this.context.viewport;
      const [w, h] = viewport.dimensions;

      return new Extent(
        viewport.unproject([pad, h - footerY - pad]),  // bottom-left
        viewport.unproject([w - pad, headerY + pad])   // top-right
      );
    } else {
      return this.setMapParams(extent.center(), this.trimmedExtentZoom(extent));
    }
  }


  /**
   * extentZoom
   * Returns the maximum zoom that will fit the given extent in the map viewport.
   * @param  extent        Extent Object to fit
   * @param  dimensions?   Array [width, height] to fit it in (defaults to viewport)
   * @return zoom
   */
  extentZoom(extent, dimensions) {
    const viewport = this.context.viewport;
    const [w, h] = dimensions || viewport.dimensions;

    const tl = viewport.project([extent.min[0], extent.max[1]]);
    const br = viewport.project([extent.max[0], extent.min[1]]);

    // Calculate maximum zoom that fits extent
    const hFactor = (br[0] - tl[0]) / w;
    const vFactor = (br[1] - tl[1]) / h;
    const hZoomDiff = Math.log(Math.abs(hFactor)) / Math.LN2;
    const vZoomDiff = Math.log(Math.abs(vFactor)) / Math.LN2;
    const zoomDiff = Math.max(hZoomDiff, vZoomDiff);

    const currZoom = viewport.transform.zoom;
    const defaultZoom = Math.max(currZoom, 19);

    return isFinite(zoomDiff) ? (currZoom - zoomDiff) : defaultZoom;
  }


  /**
   * trimmedExtentZoom
   * Returns the maximum zoom that will fit the given extent in the map viewport,
   *   but zoomed out slightly to account for header, footer, etc.
   * @param  extent    Extent Object to fit
   * @return zoom
   */
  trimmedExtentZoom(extent) {
// Add 50px overscan experiment, see UISystem.js
// Maybe find a nicer way to include overscan and view padding into places like this.
    const trimW = 140;
    const trimH = 240;
    //const trimW = 40;
    //const trimH = 140;

    const viewport = this.context.viewport;
    const trimmed = vecSubtract(viewport.dimensions, [trimW, trimH]);
    return this.extentZoom(extent, trimmed);
  }


  /**
   * highlightEdits
   * set/get whether to show edited features in a special style
   */
  get highlightEdits() {
    return this._highlightEdits;
  }
  set highlightEdits(val) {
    if (this._highlightEdits === val) return;  // no change

    this._highlightEdits = val;

    const gfx = this.context.systems.gfx;
    gfx.scene.dirtyScene();
    gfx.immediateRedraw();
    this.emit('mapchange');
  }


  /**
   * areaFillMode
   * set/get the area fill mode - one of 'full', 'partial' (default), or 'wireframe'
   */
  get areaFillMode() {
    return this._currFillMode;
  }
  set areaFillMode(val) {
    const context = this.context;
    const gfx = context.systems.gfx;
    const storage = context.systems.storage;

    const current = this._currFillMode;
    if (current === val) return;  // no change

    if (current !== 'wireframe') {
      this._toggleFillMode = current;
      storage.setItem('area-fill-toggle', current);  // remember the previous *non-wireframe* fill mode
    }

    this._currFillMode = val;
    storage.setItem('area-fill', val);

    gfx.scene.dirtyScene();
    gfx.immediateRedraw();
    this.emit('mapchange');
  }


  /**
   * wireframeMode
   * set/get whether the area fill mode is set to 'wireframe'
   */
  get wireframeMode() {
    return this._currFillMode === 'wireframe';
  }
  set wireframeMode(val) {
    if (val) {
      if (this.areaFillMode !== 'wireframe') {
        this.areaFillMode = 'wireframe';
      }
    } else {
      this.areaFillMode = this._toggleFillMode;  // go back to the previous *non-wireframe* fill mode
    }
  }

}
