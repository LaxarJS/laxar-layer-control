/**
 * Copyright 2015-2017 aixigo AG
 * Released under the MIT license.
 * http://laxarjs.org/license
 */
import * as $ from 'jquery';
import * as ng from 'angular';
import { assert, object } from 'laxar';
import { calculateDomData } from './lib/layer_utils';
import { create as createLayerAnchorPositioning } from './lib/layer_anchor_positioning';
import { create as createLayerFixedPositioning } from './lib/layer_fixed_positioning';
import { create as createLayerAbsolutePositioning } from './lib/layer_absolute_positioning';


const directiveName = 'axLayer';
let waitAnimationsTimeout;
let checkSizeTimeout;
let hideElementOutsideTabTimeout;

//////////////////////////////////////////////////////////////////////////////////////////////////////////////

const directive = [ () => {
   let layerIdCounter = 0;

   return {
      restrict: 'A',
      template: '<div ng-transclude style="height: auto; padding: 0; margin: 0; border: none;"></div>',
      transclude: true,
      scope: true,
      link( scope, iElement, iAttrs ) {
         scope.layer = new Layer();

         if( !iElement.attr( 'id' ) ) {
            iElement.attr( 'id', directiveName + layerIdCounter++ );
         }

         scope.$watch( iAttrs.axLayerShow, ( newValue, oldValue ) => {
            if( newValue ) {
               const configuration = scope.$eval( iAttrs[ directiveName ] );
               scope.layer.setConfiguration( configuration );
               scope.layer.show();
            }
            else if( newValue !== oldValue ) {
               scope.layer.hide();
            }
         } );

         scope.$on( '$destroy', () => {
            clearTimeout( waitAnimationsTimeout );
            clearTimeout( checkSizeTimeout );
            clearTimeout( hideElementOutsideTabTimeout );
            $( window.document ).off( namespaced( 'keyup' ), escapeKeyHandler );
            $( window.document ).off( namespaced( 'click' ), outsideClickHandler );

            try {
               scope.layer.hide();
            }
            catch( e ) {
               // ignore. This can happen if the DOM node was already destroyed while the directive was not
            }

            delete scope.layer;
         } );

         scope.$on( 'closeLayerForced', () => {
            scope.layer.hide( true );
         } );
      }
   };
} ];

const openLayerStack = [];

//////////////////////////////////////////////////////////////////////////////////////////////////////////////

function Layer( configuration ) {
   this.setConfiguration( configuration );
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////////

Layer.prototype = {

   setConfiguration( configuration ) {
      this.configuration_ = object.options( configuration, {
         allowedPositions: [ 'top', 'right', 'bottom', 'left' ],
         arrowWidth: 0,
         arrowHeight: 0,
         autoFocus: true,
         captureFocus: true,
         closeByKeyboard: true,
         closeByOutsideClick: true,
         contentAreaSelector: null,
         positioning: 'centered',
         whenPositioned() {},
         whenClosed() {},
         preventBodyScrolling: false
      } );
      this.hidden = true;
   },

   ///////////////////////////////////////////////////////////////////////////////////////////////////////////

   show() {
      assert( this.configuration_.layerElementSelector ).hasType( String ).isNotNull();

      const $layer = $( this.configuration_.layerElementSelector );
      assert.state( $layer.length === 1,
                    `No element with selector "${this.configuration_.layerElementSelector}" found.` );

      this.id = $layer.attr( 'id' );
      this.hidden = false;
      if( openLayerStack.length === 0 ) {
         $( window.document ).on( namespaced( 'keyup' ), escapeKeyHandler );
         $( window.document ).on( namespaced( 'click' ), outsideClickHandler );
      }
      openLayerStack.push( this );

      $layer.css( {
         visibility: 'hidden',
         position: 'absolute',
         display: 'block'
      } );

      /*
      Some remarks on how the strategy for positioning is determined:
      When an `anchorElementSelector` is provided, the anchor positioning strategy is used and the layer is
      anchored to the according element. The `allowedPositions` determine on which side the layer may be
      drawn. The first position that matches best from the allowed positions is used.

      Otherwise the positioning configuration is read and if that equals `middle`, the layer gets
      position `fixed` and the layerFixedPositioning strategy is applied.

      If none of the both cases matches, the layer gets position `absolute` and is attached to the top of
      the document via the layerAbsolutePositioning strategy.

      Both, the layerFixedPositioning and the layerAbsolutePositioning strategy are currently limited to
      center and top respectively but may be extended for more locations in the future. So for now their
      names may promise more than they actually offer.
       */

      const self = this;
      if( typeof this.configuration_.anchorElementSelector === 'string' ) {
         $layer.css( 'position', 'absolute' );
         const $anchor = $( this.configuration_.anchorElementSelector );

         assert.state( $anchor.length === 1,
                       `No element with selector "${this.configuration_.anchorElementSelector}" found.` );

         this.positioningStrategy = createLayerAnchorPositioning( this, $layer );
      }
      else if( this.configuration_.positioning === 'middle' ) {
         $layer.css( 'position', 'fixed' );
         this.positioningStrategy = createLayerFixedPositioning( this, $layer );
      }
      else {
         $layer.css( 'position', 'absolute' );
         this.positioningStrategy = createLayerAbsolutePositioning( this, $layer );
      }

      calculateAndApplyPositioningViaStrategy( this, $layer, false );
      const initialWatchData = getResizingWatchData( this, $layer );

      $layer.css( {
         display: 'none',
         visibility: ''
      } );

      this.activeElementBeforeOpen_ = document.activeElement;
      $layer.fadeIn( 'fast', () => {
         startResizeWatching( self, $layer, initialWatchData );

         if( self.configuration_.captureFocus ) {
            attachTabCaptureListener( self, $layer );
         }
         else {
            attachOutsideTabListener( self, $layer );
         }

         const nodes = getTabbableNodes( $layer );
         if( self.configuration_.autoFocus ) {
            if( nodes.length > 0 ) {
               secureFocus( nodes[ 0 ] );
            }
         }
         else if( self.activeElementBeforeOpen_ ) {
            self.activeElementBeforeOpen_.blur();
         }

         $layer.addClass( 'ax-showing' );
      } );

      if( this.configuration_.preventBodyScrolling ) {
         $( 'body' ).css( 'overflow', 'hidden' );
      }
   },

   ///////////////////////////////////////////////////////////////////////////////////////////////////////////

   hide( forcedClose ) {
      const index = openLayerStack.indexOf( this );
      if( index === -1 ) {
         return;
      }
      openLayerStack.splice( index, 1 );

      if( openLayerStack.length === 0 ) {
         $( window.document ).off( namespaced( 'keyup' ) );
         $( window.document ).off( namespaced( 'click' ) );
      }

      const $layer = $( this.configuration_.layerElementSelector );

      this.configuration_.whenClosed( !!forcedClose );
      const self = this;

      $layer.fadeOut( 'fast', () => {
         $( document ).off( namespaced( 'keydown', this ) );

         if( self.activeElementBeforeOpen_ ) {
            secureFocus( self.activeElementBeforeOpen_ );
         }

         $layer.removeClass( 'ax-showing' );
      } );
      if( this.configuration_.arrowElementId ) {
         $( `#${this.configuration_.arrowElementId}` ).fadeOut( 'fast' );
      }
      if( this.configuration_.preventBodyScrolling ) {
         $( 'body' ).css( 'overflow', '' );
      }

      this.hidden = true;
   }

};

//////////////////////////////////////////////////////////////////////////////////////////////////////////////

function startResizeWatching( self, $layer, initialWatchData ) {
   const CHECK_TIMEOUT = 250;
   const WAIT_TIMEOUT = 30;

   let watchData = initialWatchData || getResizingWatchData( self, $layer );
   function checkSize() {
      if( self.hidden ) {
         return;
      }

      const newData = getResizingWatchData( self, $layer );
      if( newData.equalTo( watchData ) ) {
         clearTimeout( checkSizeTimeout );
         checkSizeTimeout = setTimeout( checkSize, CHECK_TIMEOUT );
         return;
      }

      watchData = newData;

      function waitForAnimationsFinished() {
         const newHeights = getResizingWatchData( self, $layer );
         if( !watchData.equalTo( newHeights ) ) {
            watchData = newHeights;
            clearTimeout( waitAnimationsTimeout );
            waitAnimationsTimeout = setTimeout( waitForAnimationsFinished, WAIT_TIMEOUT );
            return;
         }
         watchData = newHeights;

         calculateAndApplyPositioningViaStrategy( self, $layer, true );

         checkSize();
      }
      clearTimeout( waitAnimationsTimeout );
      waitAnimationsTimeout = setTimeout( waitForAnimationsFinished, WAIT_TIMEOUT );
   }

   checkSize();
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////////

function getResizingWatchData( self, $layer ) {
   const $anchor = self.configuration_.anchorElementSelector ?
      $( self.configuration_.anchorElementSelector ) : $( 'body' );

   return {
      anchor: $anchor.offset(),
      content: $layer.children( '[ng-transclude]' ).outerHeight(),
      window: $( window ).height(),
      scrollTop: $( window ).scrollTop(),
      equalTo( other ) {
         return this.content === other.content &&
            this.window === other.window &&
            this.scrollTop === other.scrollTop &&
            this.anchor.top === other.anchor.top &&
            this.anchor.left === other.anchor.left;
      }
   };
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////////

function calculateAndApplyPositioningViaStrategy( self, $layer, animated ) {

   // Finish all ongoing animations to prevent from wrong height calculations
   $layer.stop( true, true );

   const domData = calculateDomData( self, $layer );
   const result = self.positioningStrategy.calculate( domData );
   let fadeInArrow = () => {};
   if( result.arrowOffsets ) {
      const $arrow = $( `#${self.configuration_.arrowElementId}` );

      const previousOffsets = $arrow.data( 'previousOffsets' );
      if( previousOffsets !== JSON.stringify( result.arrowOffsets ) ) {
         if( $arrow.is( ':visible' ) ) {
            $arrow.fadeOut( 'fast' );
         }
         $arrow.css( result.arrowOffsets );
         fadeInArrow = $arrow.fadeIn.bind( $arrow, 'fast' );
         $arrow.data( 'previousOffsets', JSON.stringify( result.arrowOffsets ) );
      }
      else if( $arrow.is( ':hidden' ) ) {
         fadeInArrow = $arrow.fadeIn.bind( $arrow, 'fast' );
      }
   }

   // We need to apply overflow styles prior to animation. jQuery.animate tries to be clever and restore
   // overflow settings _after_ animation. In our case this would result in obsolete value being restored
   // again.
   $layer.css( result.styles );
   if( animated ) {
      $layer.animate( result.offsets, fadeInArrow );
   }
   else {
      $layer.css( result.offsets );
      fadeInArrow();
   }

   self.configuration_.whenPositioned();
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////////

function attachTabCaptureListener( self, $layer ) {
   $( document ).on( namespaced( 'keydown', self ), event => {
      if( event.keyCode !== 9 ) {
         return;
      }

      event.preventDefault();
      const tabbableNodes = getTabbableNodes( $layer );
      const index = tabbableNodes.indexOf( document.activeElement );
      let newIndex;
      if( event.shiftKey ) {
         newIndex = ( index - 1 >= 0 ) ? index - 1 : tabbableNodes.length - 1;
      }
      else {
         newIndex = ( index + 1 < tabbableNodes.length ) ? index + 1 : 0;
      }
      secureFocus( tabbableNodes[ newIndex ] );
   } );
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////////

function attachOutsideTabListener( self, $layer) {
   $( document ).on( namespaced( 'keydown', self ), event => {
      if( event.keyCode !== 9 ) {
         return;
      }

      const currentActiveElement = document.activeElement;
      clearTimeout( hideElementOutsideTabTimeout );
      hideElementOutsideTabTimeout = setTimeout( () => {
         if( currentActiveElement === document.activeElement ) {
            // Firefox doesn't register, if the tab leads us to a control outside of the active document
            // (i.e. some control in firebug)
            self.hide( true );
         }

         if( !document.activeElement || $( document.activeElement ).closest( $layer ).length === 0 ) {
            self.hide( true );
         }
      }, 0 );
   } );
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////////

function escapeKeyHandler( event ) {
   if( event.keyCode === 27 ) {
      for( let i = openLayerStack.length - 1; i >= 0; --i ) {
         const layer = openLayerStack[ i ];
         if( layer.configuration_.closeByKeyboard ) {
            layer.hide( true );

            event.preventDefault();
            event.stopImmediatePropagation();
            return;
         }
      }
   }
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////////

function isDetached( target ) {
   let node = target;
   while( node !== document.documentElement ) {
      node = node.parentNode;
      if( !node ) {
         return true;
      }
   }
   return false;
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////////

/* Unfortunately chrome's offsetParent does not work reliably. */
function offsetParent( target ) {
   let node = target;
   while( node !== document.documentElement ) {
      node = node.parentNode;
      if( !node ) {
         return null;
      }
      const position = $( node ).css( 'position' );
      if( !( position === 'static' || position === 'auto' ) ) {
         return node;
      }
   }
   return document.documentElement;
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////////

/* Check if target is visually in front of the layer */
function isOnTopOf( target, $layerElement ) {
   let node = target;
   const position = window.getComputedStyle( target, 'position' );
   if( node.offsetParent === document.body && ( position === 'static' || position === 'auto' ) ) {
      return false;
   }

   const body = document.body;
   const html = document.documentElement;
   if( node === html || node === body ) {
      // The node is the page background.
      return false;
   }

   // Try to compare depth-order:
   // 1. Find the offset-ancestor of the target node which is an offset-sibling of the layer.
   // 2. Compare their z-indices.
   // 3. If these are identical, that node is in front which occurs later in the DOM.
   let oP = offsetParent( node );
   while( oP !== body && oP !== html ) {
      node = oP;
      oP = offsetParent( node );
      if( !oP ) {
         // Detached offset parent
         return true;
      }
   }
   const zNode = zIndex( node );
   const zLayer = zIndex( $layerElement );
   if( zNode !== zLayer ) {
      return zNode > zLayer;
   }

   // z-index is identical, compare dom order
   while( node.parentNode !== body ) {
      node = node.parentNode;
   }
   let next = $layerElement[ 0 ];
   while( next ) {
      next = next.nextSibling;
      if( next === node ) {
         return false;
      }
   }
   return true;
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////////

function outsideClickHandler( event ) {
   const clickCoords = {
      left: event.pageX,
      top: event.pageY
   };

   function inElement( $layerElement ) {
      const offset = $layerElement.offset();
      if( clickCoords.left < offset.left || clickCoords.left > offset.left + $layerElement.outerWidth() ) {
         return false;
      }
      if( clickCoords.top < offset.top || clickCoords.top > offset.top + $layerElement.outerHeight() ) {
         return false;
      }
      return undefined;
   }

   const length = openLayerStack.length;
   for( let i = length - 1; i >= 0; --i ) {
      const layer = openLayerStack[ i ];
      if( layer.configuration_.closeByOutsideClick ) {
         const $layerElement = $( layer.configuration_.layerElementSelector );
         // We need to check the event target as e.g. select boxes lead to bogus page coordinates within
         // the event at least in Google Chrome. In other browsers we only have a problem, if the Options
         // list overlaps the layer's border and an option outside of the layer is clicked. Thus we only
         // close the layer if
         // - the coordinates are outside AND
         // - target is not in a layer that is detached (jqueryUI datepicker) or in front of this layer AND
         // - the target element is not a child of the layer.
         if( !( inElement( $layerElement ) ||
                isDetached( event.target ) ||
                isOnTopOf( event.target, $layerElement ) ||
                $( event.target ).closest( $layerElement ).length ) ) {
            layer.hide( true );
         }
      }
   }

   // NEEDS FIX B: This should have prevented from outside clicks to trigger click handlers there ("click
   // through"), but it doesn't work because of event bubbling ... Additionally it isn't possible to
   // completely prevent a click event by calling preventDefault() on mousedown.
   if( length > openLayerStack.length ) {
      event.preventDefault();
      event.stopImmediatePropagation();
   }
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////////

function getTabbableNodes( $layer ) {
   const nodes = [];
   $layer.find( 'input,a,button,textarea,select,[tabindex]' ).each( ( index, node ) => {
      if( node.nodeType !== 1 || node.disabled ) {
         return;
      }

      if( node.type === 'hidden' && node.nodeName.toLowerCase() === 'input' ) {
         return;
      }

      const $node = $( node );
      if( $node.is( ':hidden' ) ) {
         return;
      }

      let tabindex = $node.attr( 'tabindex' );
      if( typeof tabindex === 'undefined' ) {
         tabindex = 0;
      }
      if( tabindex >= 0 ) {
         node.ax__tabindexForSorting = parseInt( tabindex, 10 );
         node.ax__indexForSorting = index;
         nodes.push( node );
      }
   } );

   nodes
      .sort( ( nodeA, nodeB ) => {
         if( nodeA.ax__tabindexForSorting === nodeB.ax__tabindexForSorting ) {
            return nodeA.ax__indexForSorting - nodeB.ax__indexForSorting;
         }

         return nodeA.ax__tabindexForSorting - nodeB.ax__tabindexForSorting;
      } )
      .forEach( node => {
         delete node.ax__tabindexForSorting;
         delete node.ax__indexForSorting;
      } );

   return nodes;
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////////

function namespaced( eventName, self ) {
   let name = `${eventName}.lib.controls.layer`;
   if( self && self.id ) {
      name += `.${self.id}`;
   }
   return name;
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////////

function secureFocus( node ) {
   try {
      node.focus();
   }
   catch( e ) {
      // ignore exceptions in IE  when focussing hidden DOM nodes
   }
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////////

/*
 * Copy of jQuerry UIs `zIndex` method, as it is deprecated there since 1.11.0:
 * http://jqueryui.com/upgrade-guide/1.11/#deprecated-zindex
 */
function zIndex( element ) {
   let $element = $( element );
   let position;
   let value;
   while( $element.length && $element[ 0 ] !== document ) {
      // Ignore z-index if position is set to a value where z-index is ignored by the browser
      // This makes behavior of this function consistent across browsers
      // WebKit always returns auto if the element is positioned
      position = $element.css( 'position' );
      if( position === 'absolute' || position === 'relative' || position === 'fixed' ) {
         // IE returns 0 when zIndex is not specified
         // other browsers return a string
         // we ignore the case of nested elements with an explicit value of 0
         // <div style="z-index: -10;"><div style="z-index: 0;"></div></div>
         value = parseInt( $element.css( 'zIndex' ), 10 );
         if( !isNaN( value ) && value !== 0 ) {
            return value;
         }
      }
      $element = $element.parent();
   }

   return 0;
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const name = ng.module( `${directiveName}Control`, [] )
   .directive( directiveName, directive )
   .name;
