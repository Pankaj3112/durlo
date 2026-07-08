export type DurloOptions = {
  id: string;
};

export class Durlo {
  readonly id: string;

  constructor(options: DurloOptions) {
    this.id = options.id;
  }
}
