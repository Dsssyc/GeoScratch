export class MercatorCoordinate {

    static mercatorXfromLon(lon: number): number;
    
    static mercatorYfromLat(lat: number): number;

    static fromLonLat(lonLat: number[]): number[];

    static toNDC(coords: number[]): number[];

    static lonFromMercatorX(x: number): number;

    static latFromMercatorY(y: number): number;

    static fromXY(xy: number[]): number[];

    static fromNDC(xy: number[]): number[];
}