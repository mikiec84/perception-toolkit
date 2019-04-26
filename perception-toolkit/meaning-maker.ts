/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Marker } from '../defs/marker.js';
import { ArtifactDealer, NearbyResultDelta, NearbyResult } from '../src/artifacts/artifact-dealer.js';
import { ArtifactLoader } from '../src/artifacts/artifact-loader.js';
import { ARArtifact } from '../src/artifacts/schema/extension-ar-artifacts.js';
import { GeoCoordinates, Thing, typeIsThing } from '../src/artifacts/schema/core-schema-org.js';
import { LocalArtifactStore } from '../src/artifacts/stores/local-artifact-store.js';
import { DetectedImage, DetectableImage } from '../defs/detected-image.js';
import { extractPageMetadata } from '../src/artifacts/extract-page-metadata.js';
import { fetchAsDocument } from '../src/utils/fetch-as-document.js';

type ShouldFetchArtifactsFromCallback = ((url: URL) => boolean);

/*
 * MeaningMaker binds the Artifacts components with the rest of the Perception Toolkit.
 * It provides a good set of default behaviours, but can be replaced with alternative
 * strategies in advanced cases.
 *
 * Things MeaningMaker adds in addition to just exposing `src/artficts/`:
 * * Creates a default Artifact Loader, Store, and Dealer.
 * * Automatically loads Artifacts from embedding Document on init.
 * * Attempts to index Pages when Markers are URLs.
 * * Makes sure to only index content from supported domains/URLs.
 */
export class MeaningMaker {
  private readonly artloader = new ArtifactLoader();
  private readonly artstore = new LocalArtifactStore();
  private readonly artdealer = new ArtifactDealer();
  private readonly pageMetadataCache = new Map<URL, Thing>();

  constructor() {
    this.artdealer.addArtifactStore(this.artstore);
  }

  /**
   * Load artifact content for initial set.
   */
  async init() {
    const artifacts = await this.artloader.fromElement(document, document.URL);
    this.saveArtifacts(artifacts);
  }

  /**
   * Load artifact content for a json-ld file.
   * This could just a small set of Artifacts defined in an external script, but often this is used to load a large
   * set of Artifacts for an entire site ("artifact sitemap").
   */
  async loadArtifactsFromJsonldUrl(url: URL): Promise<ARArtifact[]> {
    const artifacts = await this.artloader.fromJsonUrl(url);
    this.saveArtifacts(artifacts);
    return artifacts;
  }

  /**
   * Load artifact content from an html file.
   * This could be used to manualy crawl a site, but usually this is just used to index a single page, for which a URL
   * was discovered at runtime.  E.g. QRCode with URL in it, or an OCR-ed URL on a poster.
   */
  async loadArtifactsFromHtmlUrl(url: URL): Promise<ARArtifact[]> {
    const doc = await fetchAsDocument(url);
    if (!doc) {
      return [];
    }
    this.savePageMetadata(doc, url);

    const artifacts = await this.artloader.fromElement(doc, url);
    this.saveArtifacts(artifacts);
    return artifacts;
  }

  /*
   * Returns the full set of potential images which are worthy of detection at this moment.
   * Each DetectableImage has one unique id, and also a list of potential Media which encodes it.
   * It is up to the caller to select the correct media encoding.
   */
  async getDetectableImages(): Promise<DetectableImage[]> {
    return this.artstore.getDetectableImages();
  }

  /*
   * Inform MeaningMaker that `marker` has been detected in camera feed.
   * `shouldFetchArtifactsFrom` is called if marker is a URL value.  If it returns `true`, MeaningMaker will index that
   * URL and extract Artifacts, if it has not already done so.
   *
   * returns `NearbyResultDelta` which can be used to update UI.
   */
  async markerFound(
      marker: Marker,
      shouldFetchArtifactsFrom?: ShouldFetchArtifactsFromCallback | string[]
  ): Promise<NearbyResultDelta> {
    shouldFetchArtifactsFrom = this.normalizeShouldFetchFn(shouldFetchArtifactsFrom);

    const url = this.checkIsFetchableURL(marker.value, shouldFetchArtifactsFrom);
    if (url) {
      await this.loadArtifactsFromHtmlUrl(url);
    }

    const results = await this.artdealer.markerFound(marker);
    results.found = await this.attemptEnrichContentWithPageMetadata(results.found, shouldFetchArtifactsFrom);
    return results;
  }

  /*
   * Inform MeaningMaker that `marker` has been lost from camera feed.
   *
   * returns `NearbyResultDelta` which can be used to update UI.
   */
  async markerLost(marker: Marker): Promise<NearbyResultDelta> {
    return this.artdealer.markerLost(marker);
  }

  /*
   * Inform MeaningMaker that geo `coords` have changed.
   *
   * returns `NearbyResultDelta` which can be used to update UI.
   */
  async updateGeolocation(
      coords: GeoCoordinates,
      shouldFetchArtifactsFrom?: ShouldFetchArtifactsFromCallback | string[]
  ): Promise<NearbyResultDelta> {
    shouldFetchArtifactsFrom = this.normalizeShouldFetchFn(shouldFetchArtifactsFrom);

    const results = await this.artdealer.updateGeolocation(coords);
    results.found = await this.attemptEnrichContentWithPageMetadata(results.found, shouldFetchArtifactsFrom);
    return results;
  }

  /*
   * Inform MeaningMaker that `detectedImage` has been found in camera feed.
   *
   * returns `NearbyResultDelta` which can be used to update UI.
   */
  async imageFound(
      detectedImage: DetectedImage,
      shouldFetchArtifactsFrom?: ShouldFetchArtifactsFromCallback | string[]
  ): Promise<NearbyResultDelta> {
    shouldFetchArtifactsFrom = this.normalizeShouldFetchFn(shouldFetchArtifactsFrom);

    const results = await this.artdealer.imageFound(detectedImage);
    results.found = await this.attemptEnrichContentWithPageMetadata(results.found, shouldFetchArtifactsFrom);
    return results;
  }

  /*
   * Inform MeaningMaker that `detectedImage` has been lost from camera feed.
   *
   * returns `NearbyResultDelta` which can be used to update UI.
   */
  async imageLost(detectedImage: DetectedImage) {
    return this.artdealer.imageLost(detectedImage);
  }

  private saveArtifacts(artifacts: ARArtifact[]) {
    for (const artifact of artifacts) {
      this.artstore.addArtifact(artifact);
    }
  }

  private normalizeShouldFetchFn(
      shouldFetchArtifactsFrom?: ShouldFetchArtifactsFromCallback | string[]): ShouldFetchArtifactsFromCallback {
    // If there's no callback provided, match to current origin.
    if (!shouldFetchArtifactsFrom) {
      shouldFetchArtifactsFrom = (url: URL) => url.origin === window.location.origin;
    } else if (Array.isArray(shouldFetchArtifactsFrom)) {
      // If an array of strings, remap it.
      const origins = shouldFetchArtifactsFrom;
      shouldFetchArtifactsFrom = (url: URL) => !!origins.find(o => o === url.origin);
    }
    return shouldFetchArtifactsFrom;
  }

  private checkIsFetchableURL(potentialUrl: string,
                              shouldFetchArtifactsFrom: ShouldFetchArtifactsFromCallback): URL | null {
    try {
      // This will throw if potentialUrl isn't a valid URL.
      // Do not supply a base url argument, since we do not want to support relative URLs,
      // and because that would turn lots of normal string values into valid relative URLs.
      const url = new URL(potentialUrl);
      if (shouldFetchArtifactsFrom(url)) {
        return url;
      }
    } catch (_) {
      // Fallthrough
    }
    return null;
  }

  private async tryExtractPageMetadata(
        potentialUrl: string,
        shouldFetchArtifactsFrom: ShouldFetchArtifactsFromCallback
      ): Promise<Thing | null> {
    const url = this.checkIsFetchableURL(potentialUrl, shouldFetchArtifactsFrom);
    if (!url) {
      return null;
    }
    if (this.pageMetadataCache.has(url)) {
      return this.pageMetadataCache.get(url) as Thing;
    }
    const doc = await fetchAsDocument(url);
    if (!doc) {
      return null;
    }
    return this.savePageMetadata(doc, url);
  }

  private savePageMetadata(doc: Document, url: URL): Thing {
    const pageMetadata = extractPageMetadata(doc, url);
    this.pageMetadataCache.set(url, pageMetadata);
    return pageMetadata;
  }

  private async attemptEnrichContentWithPageMetadata(
        results: NearbyResult[],
        shouldFetchArtifactsFrom: ShouldFetchArtifactsFromCallback
      ): Promise<NearbyResult[]> {
    for (const result of results) {
      if (!result.content) {
        continue;
      }
      if (!typeIsThing(result.content)) {
        // if arContent is a string, try to treat it as a URL
        const pageMetadata = await this.tryExtractPageMetadata(result.content, shouldFetchArtifactsFrom);
        if (pageMetadata) {
          // Override the string URL with the metadata object
          result.content = pageMetadata;
        }
      } else if (result.content.url && !result.content.hasOwnProperty('name')) {
        // if arContent has a 'url' property, but lacks properties, check the page for missing metadata.
        // For now, make sure the @type's match exactly, so we only ever expand metadata.
        const pageMetadata = await this.tryExtractPageMetadata(result.content.url, shouldFetchArtifactsFrom);
        if (pageMetadata && pageMetadata['@type'] === result.content['@type']) {
          // Use the new metadata object, but keep all the existing property values.
          result.content = Object.assign(pageMetadata, result.content);
        }
      }
    }
    return results;
  }
}
