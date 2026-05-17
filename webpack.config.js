var webpack = require('webpack')
const path = require('path')
const MiniCssExtractPlugin = require('mini-css-extract-plugin')
const HtmlWebpackPlugin = require('html-webpack-plugin')
const Dotenv = require('dotenv-webpack');

module.exports = {
    devtool: 'eval-source-map',
    context: __dirname,
    entry: "./app/app.js",
    output: {
        path: path.resolve(__dirname, 'build'),
        filename: "gecko.[contenthash].js",
        clean: true
    },
    resolve: {
        alias: {
            '@': path.join(__dirname, 'app'),
        },
        fallback: {
            "stream": require.resolve("stream-browserify"),
            // "fs": false,
            // "tls": false,
            // "net": false,
            // "path": false,
            // "zlib": false,
            // "http": false,
            // "https": false,
            // "stream": false,
            // "crypto": false,
        }
    },
    devServer: {
        static: {
            publicPath: 'build/',
            //contentBase: 'build/', // Relative directory for base of server
        },
        //inline: true,
        port: 4000, // Port Number
        host: 'localhost', // Change to '0.0.0.0' for external facing server
        historyApiFallback: true,
        allowedHosts: 'all',
    },
    module: {
        rules: [
            {
                test: /\.js$/,
                exclude: /node_modules/,
                use: [
                    {
                        loader: 'babel-loader',
                        options: {
                            cacheDirectory: true,
                        },
                    }
                ]
            },
            {
                test: /\.css$/,
                use: [
                    {
                        loader: MiniCssExtractPlugin.loader,
                    },
                    'css-loader',
                ],
            },
            {
                test: /soundtouch\.js$/,
                use: [
                    {
                        loader: "imports-loader?this=>window"
                    }
                ]
                //loader: "imports-loader?this=>window"
            },
            {
                test: /\.(woff|woff2)(\?v=[0-9]\.[0-9]\.[0-9])?$/,
                type: 'asset/resource',
            },
            {
                test: /\.(ttf|eot|svg)(\?[\s\S]+)?$/,
                type: 'asset/resource',
            },
            {
                test: /\.(jpe?g|png|gif)$/i,
                type: 'asset/resource',
                generator: {
                    filename: 'images/[name][ext]',
                },
            },
            {
                test: /\.ctm$/i,
                use: 'raw-loader',
              }
        ]
    },
    plugins: [
        new MiniCssExtractPlugin({
            filename: 'gecko.[contenthash].css'
        }),
        new HtmlWebpackPlugin({
            filename: 'index.html',
            template: './static/index.html'
        }),
        new Dotenv()
    ]
}
